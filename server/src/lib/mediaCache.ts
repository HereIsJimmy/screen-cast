import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getStreamContentType } from "./library.js";
import type { VideoEntry } from "../types.js";

function cacheKey(entry: VideoEntry): string {
  return `${entry.id}-${Math.round(entry.mtimeMs)}-${entry.sizeBytes}`;
}

// Codecs that Chromecast / Google TV can decode directly once packaged in an
// MP4 container, so we only need to *copy* the stream (fast, lossless)
// rather than re-encode it.
const VIDEO_COPY_CODECS = new Set(["h264", "hevc", "h265"]);
const AUDIO_COPY_CODECS = new Set(["aac", "mp3"]);

// Codecs a plain in-browser <video> element (Chrome/Firefox/Edge without a
// licensed hardware HEVC decoder) can actually decode. Notably this excludes
// HEVC/H.265: Chromecast/Google TV plays it fine in hardware, so it's
// treated as copy-safe above, but serving that same file to a local <video>
// tag plays the audio track (decoded independently) and shows subtitle text
// (rendered by the browser, not the video decoder) while the picture stays
// black — the video frames themselves never decode. Browser playback needs
// its own, stricter check and its own cached output.
const BROWSER_VIDEO_COPY_CODECS = new Set(["h264"]);
const BROWSER_VIDEO_DIRECT_CODECS = new Set(["h264"]);
const WEBM_BROWSER_VIDEO_CODECS = new Set(["vp8", "vp9"]);
const WEBM_BROWSER_AUDIO_CODECS = new Set(["opus", "vorbis"]);

/** Playback target: "cast" (Chromecast/TV) or "browser" (local <video> tag). */
export type PlayTarget = "cast" | "browser";

function isBrowserDirectPlayable(entry: VideoEntry): boolean {
  const v = entry.videoCodec?.toLowerCase() ?? null;
  const a = entry.audioCodec?.toLowerCase() ?? null;
  if (!v) return false;
  if ([".mp4", ".m4v"].includes(entry.containerExt)) {
    return BROWSER_VIDEO_DIRECT_CODECS.has(v) && (a === null || AUDIO_COPY_CODECS.has(a));
  }
  if (entry.containerExt === ".webm") {
    return WEBM_BROWSER_VIDEO_CODECS.has(v) && (a === null || WEBM_BROWSER_AUDIO_CODECS.has(a));
  }
  return false;
}

/** Codec of one specific audio track, or null when that index doesn't exist. */
function audioTrackCodec(entry: VideoEntry, audioTrackIndex: number): string | null {
  return entry.audioTracks.find((t) => t.index === audioTrackIndex)?.codec ?? null;
}

/**
 * File-name suffix (on top of the "-browser" one) for the entry's *default*
 * audio track — "" for track 0, "-a{N}" otherwise. isBrowserReady and
 * deleteBrowserCache use this to look at the same cache file getPlayablePath
 * produces/reuses when a request omits ?audio and falls back to
 * entry.defaultAudioTrackIndex (see getAudioTrackIndex in routes/stream.ts).
 */
function defaultBrowserCacheSuffix(entry: VideoEntry): string {
  return entry.defaultAudioTrackIndex === 0 ? "" : `-a${entry.defaultAudioTrackIndex}`;
}

/**
 * True when a video can be streamed to a local <video> element right now,
 * with no wait: either it doesn't need any processing for the browser at
 * all (isBrowserDirectPlayable — only possible when the default audio
 * track is literally the file's first one, since serving the untouched
 * file always plays that one), or a previous prepare/play already left its
 * browser-targeted remux/transcode for the default audio track sitting in
 * the cache. This is a plain disk check — it never runs ffmpeg — so it's
 * cheap enough to call for every video when building the library listing
 * (see library.ts toDTO), which is how the client knows to show a ready
 * checkmark instead of the "prepare" button without having to ask
 * separately per video.
 */
export function isBrowserReady(entry: VideoEntry): boolean {
  if (entry.defaultAudioTrackIndex === 0 && isBrowserDirectPlayable(entry)) return true;
  const cachedPath = path.join(config.cacheDir, `${cacheKey(entry)}-browser${defaultBrowserCacheSuffix(entry)}.mp4`);
  return existsSync(cachedPath);
}

/**
 * Removes just the cached browser remux/transcode for a video's default
 * audio track (the file getPlayablePath(entry, "browser") produces and
 * reuses when no specific track is requested), leaving its Chromecast
 * remux, subtitles, thumbnail, and any other audio-track-specific browser
 * remux alone. Used by the library grid's ready checkmark: clicking it
 * un-prepares the video — handy to reclaim disk space, or to force a fresh
 * transcode later (e.g. after changing something upstream). A no-op for a
 * video that never needed a cache file to begin with
 * (isBrowserDirectPlayable) — there's nothing on disk to remove, so it
 * stays ready either way.
 */
export async function deleteBrowserCache(entry: VideoEntry): Promise<{ removed: boolean }> {
  const cachedPath = path.join(config.cacheDir, `${cacheKey(entry)}-browser${defaultBrowserCacheSuffix(entry)}.mp4`);
  if (!existsSync(cachedPath)) return { removed: false };
  await fs.rm(cachedPath, { force: true });
  return { removed: true };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Keep only the tail — ffmpeg's stderr can be very chatty.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg salió con código ${code}\n${stderr}`));
    });
  });
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(config.cacheDir, { recursive: true });
}

// A video's id (see makeId in library.ts) is always the first 16 characters
// of its cache filenames — every cache file for it is named
// "{id}-{mtime}-{size}[-suffix].{ext}". That fixed-width prefix is what lets
// the prune helpers below tell which video a cache file belongs to without
// needing to track cache filenames anywhere else.
const CACHE_ID_PREFIX_LENGTH = 16;

/** True for a completed cache file; false for a still-being-written "*.tmp.*" one. */
function isFinishedCacheFile(name: string): boolean {
  return !name.includes(".tmp.");
}

/**
 * Deletes cached remux/transcode .mp4 files (both the Chromecast and the
 * browser variant) that weren't written today. Meant to run once per server
 * start: the cache exists to make *repeat* plays within a run instant, not
 * to accumulate multi-gigabyte remuxes on disk forever — subtitle .vtt and
 * thumbnail .jpg files are cheap and left alone here. Best-effort: a file
 * that disappears mid-loop (e.g. another prune racing it) is just skipped.
 */
export async function pruneStaleCache(): Promise<{ removed: number }> {
  await ensureCacheDir();
  const names = await fs.readdir(config.cacheDir);
  const todayKey = new Date().toDateString();

  const targets = names.filter((name) => name.endsWith(".mp4") && isFinishedCacheFile(name));

  let removed = 0;
  await Promise.all(
    targets.map(async (name) => {
      const filePath = path.join(config.cacheDir, name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtime.toDateString() !== todayKey) {
          await fs.rm(filePath, { force: true });
          removed += 1;
        }
      } catch {
        /* removed concurrently, or a transient stat error — not worth failing startup over */
      }
    })
  );

  return { removed };
}

/**
 * Deletes every cache file (remux, browser remux, subtitle .vtt, thumbnail
 * .jpg) belonging to one specific video id. Used when a video is deleted
 * outright (see library.ts deleteVideo) — unlike pruneOrphanedCache below,
 * this targets a single known id instead of diffing against the whole
 * index, so it can run right away without waiting for the next scan.
 */
export async function deleteCacheForId(id: string): Promise<{ removed: number }> {
  await ensureCacheDir();
  let names: string[];
  try {
    names = await fs.readdir(config.cacheDir);
  } catch {
    return { removed: 0 };
  }

  const matches = names.filter((name) => name.slice(0, CACHE_ID_PREFIX_LENGTH) === id);

  let removed = 0;
  await Promise.all(
    matches.map(async (name) => {
      try {
        await fs.rm(path.join(config.cacheDir, name), { force: true });
        removed += 1;
      } catch {
        /* already gone — fine */
      }
    })
  );

  return { removed };
}

/**
 * Deletes every cache file (remux, browser remux, subtitle .vtt, thumbnail
 * .jpg) belonging to a video id that isn't in `validIds` — leftovers from a
 * file that was deleted, renamed, or moved out of MEDIA_DIRS since the last
 * scan. Called after each library scan finishes, so these never just pile
 * up in server/.cache once their video is gone.
 */
export async function pruneOrphanedCache(validIds: ReadonlySet<string>): Promise<{ removed: number }> {
  await ensureCacheDir();
  const names = await fs.readdir(config.cacheDir);

  const orphaned = names.filter((name) => {
    if (!isFinishedCacheFile(name)) return false;
    const id = name.slice(0, CACHE_ID_PREFIX_LENGTH);
    return !validIds.has(id);
  });

  let removed = 0;
  await Promise.all(
    orphaned.map(async (name) => {
      try {
        await fs.rm(path.join(config.cacheDir, name), { force: true });
        removed += 1;
      } catch {
        /* already gone — fine */
      }
    })
  );

  return { removed };
}

// Dedupe concurrent requests for the same output file (e.g. several Range
// requests from the TV arriving before the first remux has finished).
const inFlight = new Map<string, Promise<string>>();

async function withDedupe(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Remuxes (or, if needed, transcodes) `entry` into a cached MP4, copying
 * each stream when its codec is already safe for the target player and
 * re-encoding it otherwise. Shared by the Chromecast and browser paths in
 * getPlayablePath, which just pass in which codecs are copy-safe for them
 * and a distinct cache-file suffix so the two never collide.
 */
async function getCachedRemux(
  entry: VideoEntry,
  opts: {
    suffix: string;
    videoCopyOk: boolean;
    audioCopyOk: boolean;
    targetLabel: string;
    audioTrackIndex: number;
    audioCodecLabel: string;
  }
): Promise<{ path: string; contentType: string }> {
  await ensureCacheDir();
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}${opts.suffix}.mp4`);

  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: "video/mp4" };
  }

  if ((!opts.videoCopyOk || !opts.audioCopyOk) && !config.allowTranscode) {
    throw new Error(
      `"${entry.relativePath}" usa códecs no compatibles con ${opts.targetLabel} ` +
        `(vídeo: ${entry.videoCodec ?? "?"}, audio: ${opts.audioCodecLabel}) y ALLOW_TRANSCODE está desactivado.`
    );
  }

  await withDedupe(outputPath, async () => {
    // ffmpeg picks the container from the output filename's extension, so
    // the temp file must itself end in ".mp4" (a ".mp4.tmp" file confuses
    // it into refusing to guess a muxer) — the "in-progress" marker goes
    // *before* the extension instead. "-f mp4" below is a belt-and-braces
    // backup in case ffmpeg ever gets a weird extension again.
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}${opts.suffix}.tmp.mp4`);
    const videoArgs = opts.videoCopyOk
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
    const audioArgs = opts.audioCopyOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];

    try {
      await runFfmpeg([
        "-y",
        "-i",
        entry.absolutePath,
        "-map",
        "0:v:0",
        "-map",
        `0:a:${opts.audioTrackIndex}?`,
        ...videoArgs,
        ...audioArgs,
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tmpPath,
      ]);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
    await fs.rename(tmpPath, outputPath);
    return outputPath;
  });

  return { path: outputPath, contentType: "video/mp4" };
}

/**
 * Returns the absolute path of the file that should be streamed for
 * playback: the original file when it's already compatible with the given
 * target, or a cached remux/transcode otherwise. The heavy work only
 * happens once per file version (keyed by id + mtime + size) and is cached
 * on disk indefinitely. Chromecast and browser playback are kept as
 * separate cache entries because a codec that's fine for one (HEVC on
 * Chromecast) can be unplayable on the other (HEVC in a desktop <video>).
 */
export async function getPlayablePath(
  entry: VideoEntry,
  target: PlayTarget = "cast",
  audioTrackIndex = 0
): Promise<{ path: string; contentType: string }> {
  // Direct-play (serving the original file untouched) only works for the
  // default audio track — anything else always needs a remux with that
  // track explicitly mapped in, even when the file would otherwise qualify.
  const audioSuffix = audioTrackIndex === 0 ? "" : `-a${audioTrackIndex}`;
  const selectedAudioCodec = audioTrackIndex === 0 ? entry.audioCodec : audioTrackCodec(entry, audioTrackIndex);

  if (target === "browser") {
    if (audioTrackIndex === 0 && isBrowserDirectPlayable(entry)) {
      const contentType = entry.containerExt === ".webm" ? "video/webm" : "video/mp4";
      return { path: entry.absolutePath, contentType };
    }
    return getCachedRemux(entry, {
      suffix: `-browser${audioSuffix}`,
      videoCopyOk: entry.videoCodec ? BROWSER_VIDEO_COPY_CODECS.has(entry.videoCodec.toLowerCase()) : false,
      audioCopyOk: selectedAudioCodec ? AUDIO_COPY_CODECS.has(selectedAudioCodec.toLowerCase()) : true,
      targetLabel: "este navegador",
      audioTrackIndex,
      audioCodecLabel: selectedAudioCodec ?? "?",
    });
  }

  if (audioTrackIndex === 0 && entry.directPlayCompatible) {
    return { path: entry.absolutePath, contentType: getStreamContentType(entry) };
  }

  // Decide per-stream whether we can just copy (fast, lossless) or need to
  // re-encode, based on the codecs ffprobe already found — rather than
  // trying a blind stream-copy remux and reacting to failure, which for
  // audio codecs like AC3/DTS would "succeed" (many containers accept them)
  // while producing a file the TV still can't play.
  return getCachedRemux(entry, {
    suffix: audioSuffix,
    videoCopyOk: entry.videoCodec ? VIDEO_COPY_CODECS.has(entry.videoCodec.toLowerCase()) : false,
    audioCopyOk: selectedAudioCodec ? AUDIO_COPY_CODECS.has(selectedAudioCodec.toLowerCase()) : true,
    targetLabel: "Chromecast",
    audioTrackIndex,
    audioCodecLabel: selectedAudioCodec ?? "?",
  });
}

/**
 * Extracts one subtitle track to a cached WebVTT file and returns its path.
 * `subtitleIndex` is the 0-based position among subtitle streams only
 * (matches ffmpeg's `-map 0:s:{index}`).
 */
export async function getSubtitleVttPath(entry: VideoEntry, subtitleIndex: number): Promise<string> {
  await ensureCacheDir();
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}-sub${subtitleIndex}.vtt`);

  if (existsSync(outputPath)) return outputPath;

  return withDedupe(outputPath, async () => {
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}-sub${subtitleIndex}.tmp.vtt`);
    await runFfmpeg([
      "-y",
      "-i",
      entry.absolutePath,
      "-map",
      `0:s:${subtitleIndex}`,
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      tmpPath,
    ]);
    await fs.rename(tmpPath, outputPath);
    return outputPath;
  });
}

/**
 * Grabs a single frame from the video as a cached JPEG thumbnail, for the
 * library grid. Seeks a little into the video (proportional to its
 * duration) rather than frame 0, since opening/black frames make for bad
 * thumbnails.
 */
export async function getThumbnailPath(entry: VideoEntry): Promise<string> {
  if (!entry.videoCodec) {
    throw new Error(`"${entry.relativePath}" no tiene pista de vídeo, no se puede generar miniatura.`);
  }

  await ensureCacheDir();
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}-thumb.jpg`);

  if (existsSync(outputPath)) return outputPath;

  return withDedupe(outputPath, async () => {
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}-thumb.tmp.jpg`);
    const seekSec = entry.durationSec ? Math.min(10, Math.max(1, Math.floor(entry.durationSec * 0.1))) : 1;

    try {
      await runFfmpeg([
        "-y",
        "-ss",
        String(seekSec),
        "-i",
        entry.absolutePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-1",
        "-q:v",
        "4",
        "-f",
        "image2",
        tmpPath,
      ]);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
    await fs.rename(tmpPath, outputPath);
    return outputPath;
  });
}
