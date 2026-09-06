import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { SubtitleTrackInfo, VideoEntry, VideoDTO } from "../types.js";
import { probeFile } from "./ffprobe.js";

const UNSUPPORTED_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "xsub",
]);

const MP4_VIDEO_CODECS = new Set(["h264", "hevc", "h265"]);
const MP4_AUDIO_CODECS = new Set(["aac", "mp3"]);
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9"]);
const WEBM_AUDIO_CODECS = new Set(["opus", "vorbis"]);

/** In-memory index of the library. Rebuilt by scanLibrary(). */
const entries = new Map<string, VideoEntry>();

/** Whether the most recently completed scan probed videos older than the "recent" window too. */
let lastScanIncludedOld = false;

export function didLastScanIncludeOld(): boolean {
  return lastScanIncludedOld;
}

function makeId(mediaRoot: string, relativePath: string): string {
  return createHash("sha1").update(`${mediaRoot}::${relativePath}`).digest("hex").slice(0, 16);
}

function titleFromRelativePath(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base
    .replace(/\[[^\]]*\]/g, " ") // strip bracketed tags, e.g. "[HEVC-10bit]"
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDirectPlayCompatible(containerExt: string, videoCodec: string | null, audioCodec: string | null): boolean {
  if (!videoCodec) return false;
  const v = videoCodec.toLowerCase();
  const a = audioCodec?.toLowerCase() ?? null;

  if ([".mp4", ".m4v"].includes(containerExt)) {
    return MP4_VIDEO_CODECS.has(v) && (a === null || MP4_AUDIO_CODECS.has(a));
  }
  if (containerExt === ".webm") {
    return WEBM_VIDEO_CODECS.has(v) && (a === null || WEBM_AUDIO_CODECS.has(a));
  }
  return false;
}

/** Timestamp (ms) of "now minus N months" — the "recent videos" cutoff. */
function getCutoffMs(months: number): number {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

async function walk(dir: string, root: string, out: { absolutePath: string; relativePath: string }[]): Promise<void> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[library] No se pudo leer la carpeta ${dir}:`, (err as Error).message);
    return;
  }

  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walk(fullPath, root, out);
    } else if (dirent.isFile()) {
      const ext = path.extname(dirent.name).toLowerCase();
      if (config.videoExtensions.includes(ext)) {
        out.push({ absolutePath: fullPath, relativePath: path.relative(root, fullPath) });
      }
    }
  }
}

type BuildResult =
  | { status: "ok"; entry: VideoEntry }
  | { status: "skipped" } // older than the cutoff — deliberately not probed
  | { status: "error" };

/**
 * Builds (or reuses) the index entry for one file. When `cutoffMs` is set and
 * the file's last-modified time is older than it, we deliberately skip
 * `ffprobe` entirely — that's the whole point of the "recent videos" filter:
 * keep scans fast by not touching old files at all, not just hiding them
 * afterwards.
 */
async function buildEntry(
  mediaRoot: string,
  absolutePath: string,
  relativePath: string,
  cutoffMs: number | null
): Promise<BuildResult> {
  const stat = await fs.stat(absolutePath);

  if (cutoffMs !== null && stat.mtimeMs < cutoffMs) {
    return { status: "skipped" };
  }

  const id = makeId(mediaRoot, relativePath);
  const existing = entries.get(id);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.sizeBytes === stat.size) {
    return { status: "ok", entry: existing }; // unchanged, skip re-probing
  }

  let durationSec: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  const subtitles: SubtitleTrackInfo[] = [];

  try {
    const probe = await probeFile(absolutePath);
    durationSec = probe.format.duration ? Math.round(Number(probe.format.duration)) : null;

    let subtitleIndex = 0;
    for (const stream of probe.streams) {
      if (stream.codec_type === "video" && !videoCodec) {
        videoCodec = stream.codec_name;
      } else if (stream.codec_type === "audio" && !audioCodec) {
        audioCodec = stream.codec_name;
      } else if (stream.codec_type === "subtitle") {
        subtitles.push({
          index: subtitleIndex,
          language: stream.tags?.language,
          title: stream.tags?.title,
          codec: stream.codec_name,
          unsupported: UNSUPPORTED_SUBTITLE_CODECS.has(stream.codec_name),
        });
        subtitleIndex += 1;
      }
    }
  } catch (err) {
    console.warn(`[library] ffprobe falló para ${absolutePath}:`, (err as Error).message);
    return { status: "error" };
  }

  const containerExt = path.extname(absolutePath).toLowerCase();

  return {
    status: "ok",
    entry: {
      id,
      absolutePath,
      relativePath,
      title: titleFromRelativePath(relativePath),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      durationSec,
      videoCodec,
      audioCodec,
      containerExt,
      directPlayCompatible: isDirectPlayCompatible(containerExt, videoCodec, audioCodec),
      subtitles,
    },
  };
}

export interface ScanOptions {
  /**
   * When true, videos older than RECENT_MONTHS are probed and indexed too.
   * When false (default), they're skipped entirely — not read with ffprobe,
   * not kept in the index — which is what keeps a re-scan fast.
   */
  includeOld?: boolean;
}

export interface ScanResult {
  count: number;
  errors: number;
  skipped: number;
  includesOld: boolean;
}

// Scans never run concurrently: each call waits for whatever scan is already
// in flight, then runs its own — simplest way to avoid two scans racing on
// the shared `entries` map (e.g. the background startup scan overlapping
// with a user-triggered rescan).
let scanChain: Promise<unknown> = Promise.resolve();

export function scanLibrary(options: ScanOptions = {}): Promise<ScanResult> {
  const run = scanChain.then(() => doScan(options));
  scanChain = run.catch(() => undefined);
  return run;
}

async function doScan(options: ScanOptions): Promise<ScanResult> {
  const includeOld = options.includeOld ?? false;
  const cutoffMs = includeOld ? null : getCutoffMs(config.recentMonths);

  const found: { absolutePath: string; relativePath: string; mediaRoot: string }[] = [];
  for (const root of config.mediaDirs) {
    const collected: { absolutePath: string; relativePath: string }[] = [];
    await walk(root, root, collected);
    for (const item of collected) found.push({ ...item, mediaRoot: root });
  }

  const seenIds = new Set<string>();
  let errors = 0;
  let skipped = 0;

  // Process in small batches to avoid spawning hundreds of ffprobe processes
  // at once on large libraries.
  const CONCURRENCY = 4;
  for (let i = 0; i < found.length; i += CONCURRENCY) {
    const batch = found.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((item) => buildEntry(item.mediaRoot, item.absolutePath, item.relativePath, cutoffMs))
    );
    batch.forEach((item, idx) => {
      const result = results[idx];
      const id = makeId(item.mediaRoot, item.relativePath);
      if (!result) return;
      if (result.status === "ok") {
        entries.set(id, result.entry);
        seenIds.add(id);
      } else if (result.status === "skipped") {
        skipped += 1;
        // Deliberately not added to seenIds: an old video that was indexed
        // during a previous includeOld=true scan gets dropped from the
        // index again once we go back to the default "recent only" scan.
      } else {
        errors += 1;
      }
    });
  }

  // Drop entries for files that no longer exist (or were skipped this time).
  for (const id of entries.keys()) {
    if (!seenIds.has(id)) entries.delete(id);
  }

  lastScanIncludedOld = includeOld;

  return { count: entries.size, errors, skipped, includesOld: includeOld };
}

/**
 * Which "day" a video belongs to, for grouping/sorting — not the calendar
 * date, but a day that runs from 8:00 to 03:59:59 the next morning (so a
 * video recorded at 1am still counts as "the same day" as one from 9pm the
 * evening before). Returned as that day's midnight timestamp, so buckets
 * compare/sort as plain numbers.
 */
function getDayBucketMs(mtimeMs: number): number {
  const d = new Date(mtimeMs);
  const bucket = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (d.getHours() < 4) {
    bucket.setDate(bucket.getDate() - 1);
  }
  return bucket.getTime();
}

export function listEntries(): VideoEntry[] {
  // Newest "day" first; videos from the same day are sorted by name.
  return Array.from(entries.values()).sort((a, b) => {
    const dayDiff = getDayBucketMs(b.mtimeMs) - getDayBucketMs(a.mtimeMs);
    if (dayDiff !== 0) return dayDiff;
    return a.title.localeCompare(b.title, "es", { sensitivity: "base", numeric: true });
  });
}

export function getEntry(id: string): VideoEntry | undefined {
  return entries.get(id);
}

/**
 * The MIME type the file will actually be served with by /videos/:id/stream:
 * "video/webm" for a directly-playable WebM, "video/mp4" for everything else
 * (both native MP4s and anything that gets remuxed/transcoded). Used both by
 * mediaCache (to know what to write) and by the client (to tell the Cast SDK
 * the right contentType up front).
 */
export function getStreamContentType(entry: VideoEntry): string {
  if (entry.directPlayCompatible && entry.containerExt === ".webm") return "video/webm";
  return "video/mp4";
}

export function toDTO(entry: VideoEntry): VideoDTO {
  return {
    id: entry.id,
    title: entry.title,
    relativePath: entry.relativePath,
    mtimeMs: entry.mtimeMs,
    durationSec: entry.durationSec,
    videoCodec: entry.videoCodec,
    audioCodec: entry.audioCodec,
    contentType: getStreamContentType(entry),
    needsProcessing: !entry.directPlayCompatible,
    subtitles: entry.subtitles.map((s) => ({
      index: s.index,
      language: s.language,
      title: s.title,
      unsupported: s.unsupported,
    })),
  };
}
