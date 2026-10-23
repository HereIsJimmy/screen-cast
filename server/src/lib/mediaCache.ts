import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getStreamContentType, pickDefaultSubtitleIndex } from "./library.js";
import { assToVtt } from "./assToVtt.js";
import { getPlaybackSettings } from "./playbackSettings.js";
import type { VideoEntry } from "../types.js";

const execFileAsync = promisify(execFile);

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

/** 10-bit (or more) H.264, aka Hi10P: common in releases, decodable by neither TVs nor browsers. */
function isHighBitDepthH264(entry: VideoEntry): boolean {
  return entry.videoHighBitDepth && entry.videoCodec?.toLowerCase() === "h264";
}

function isBrowserDirectPlayable(entry: VideoEntry): boolean {
  const v = entry.videoCodec?.toLowerCase() ?? null;
  const a = entry.audioCodec?.toLowerCase() ?? null;
  if (!v || entry.videoHighBitDepth) return false;
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

/** True for an ASS/SSA subtitle track, the only kind that can be burned in (see getPlayablePath). */
export function isBurnableSubtitle(entry: VideoEntry, subtitleIndex: number): boolean {
  const track = entry.subtitles.find((s) => s.index === subtitleIndex);
  const codec = track?.codec.toLowerCase();
  return !!track && !track.unsupported && (codec === "ass" || codec === "ssa");
}

/**
 * Subtitle track burned in when a request doesn't say (no ?burn): the
 * preselected track (pickDefaultSubtitleIndex) if it's ASS/SSA and burning
 * in is on by default (PlaybackSettings.burnInByDefault) — otherwise none.
 */
export function defaultBurnSubtitleIndex(entry: VideoEntry): number | null {
  if (!getPlaybackSettings().burnInByDefault) return null;
  const index = pickDefaultSubtitleIndex(entry.subtitles);
  return index !== null && isBurnableSubtitle(entry, index) ? index : null;
}

/** Cache-file suffix of a burned-in remux. Shared by both targets: its output plays on either. */
function burnCacheSuffix(subtitleIndex: number, audioTrackIndex: number): string {
  return `-burn${subtitleIndex}${audioTrackIndex === 0 ? "" : `-a${audioTrackIndex}`}`;
}

/**
 * The cache file getPlayablePath(entry, target) produces/reuses for a
 * request with no ?audio and no ?burn (the server's defaults, which is what
 * the library grid's prepare buttons ask for), or null when that request is
 * served straight from the original file and needs no cache file at all.
 */
function defaultCachePath(entry: VideoEntry, target: PlayTarget): string | null {
  const burnIndex = defaultBurnSubtitleIndex(entry);
  let suffix: string;
  if (burnIndex !== null) {
    suffix = burnCacheSuffix(burnIndex, entry.defaultAudioTrackIndex);
  } else if (target === "browser") {
    if (entry.defaultAudioTrackIndex === 0 && isBrowserDirectPlayable(entry)) return null;
    suffix = `-browser${defaultBrowserCacheSuffix(entry)}`;
  } else {
    if (entry.defaultAudioTrackIndex === 0 && entry.directPlayCompatible) return null;
    suffix = defaultBrowserCacheSuffix(entry); // the Chromecast remux has no "-browser" part
  }
  return path.join(config.cacheDir, `${cacheKey(entry)}${suffix}.mp4`);
}

/**
 * True when a video can be played on `target` right now, with no wait:
 * either its default stream needs no processing at all, or a previous
 * prepare/play already left it in the cache. This is a plain disk check —
 * it never runs ffmpeg — so it's cheap enough to call for every video when
 * building the library listing (see library.ts toDTO), which is how the
 * client knows how to draw each thumbnail's prepare buttons without asking
 * separately per video.
 */
export function isPrepared(entry: VideoEntry, target: PlayTarget): boolean {
  const cachedPath = defaultCachePath(entry, target);
  return cachedPath === null || existsSync(cachedPath);
}

/**
 * Removes just the cached file behind isPrepared(entry, target), leaving
 * every other cache file alone. Used by the library grid's prepare buttons:
 * clicking a prepared one un-prepares the video — handy to reclaim disk
 * space, or to force a fresh transcode later. A burned-in remux is shared by
 * both targets (see getPlayablePath), so removing it un-prepares both. A
 * no-op for a video that never needed a cache file (it stays ready).
 */
export async function deletePreparedCache(entry: VideoEntry, target: PlayTarget): Promise<{ removed: boolean }> {
  const cachedPath = defaultCachePath(entry, target);
  if (cachedPath === null || !existsSync(cachedPath)) return { removed: false };
  await fs.rm(cachedPath, { force: true });
  return { removed: true };
}

function runFfmpeg(args: string[], opts?: { cwd?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], cwd: opts?.cwd });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Keep only the tail — ffmpeg's stderr can be very chatty.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
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
    /** ASS/SSA subtitle track to render into the picture (forces a video re-encode). */
    burnSubtitleIndex?: number;
  }
): Promise<{ path: string; contentType: string }> {
  await ensureCacheDir();
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}${opts.suffix}.mp4`);

  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: "video/mp4" };
  }

  if (opts.burnSubtitleIndex !== undefined && !config.allowTranscode) {
    throw new Error("Burning in subtitles re-encodes the video, and ALLOW_TRANSCODE is off.");
  }
  if ((!opts.videoCopyOk || !opts.audioCopyOk) && !config.allowTranscode) {
    throw new Error(
      `"${entry.relativePath}" uses codecs not supported by ${opts.targetLabel} ` +
        `(video: ${entry.videoCodec ?? "?"}, audio: ${opts.audioCodecLabel}) and ALLOW_TRANSCODE is off.`
    );
  }

  await withDedupe(outputPath, async () => {
    // ffmpeg picks the container from the output filename's extension, so
    // the temp file must itself end in ".mp4" (a ".mp4.tmp" file confuses
    // it into refusing to guess a muxer) — the "in-progress" marker goes
    // *before* the extension instead. "-f mp4" below is a belt-and-braces
    // backup in case ffmpeg ever gets a weird extension again.
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}${opts.suffix}.tmp.mp4`);
    // A copied HEVC stream gets ffmpeg's default "hev1" sample entry in MP4,
    // which Google TV / Chromecast receivers often won't play — they sit on
    // the loading spinner forever without reporting an error. "hvc1" is the
    // tag every HEVC-capable player accepts.
    const isHevc = ["hevc", "h265"].includes(entry.videoCodec?.toLowerCase() ?? "");
    const videoArgs = opts.videoCopyOk
      ? ["-c:v", "copy", ...(isHevc ? ["-tag:v", "hvc1"] : [])]
      : // "-pix_fmt yuv420p" matters for 10-bit sources: without it libx264
        // keeps the bit depth and outputs H.264 High 10, which neither
        // Chromecast nor browsers can decode either.
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
    const audioArgs = opts.audioCopyOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];

    if (opts.burnSubtitleIndex !== undefined) {
      try {
        await burnSubtitles(entry, opts.burnSubtitleIndex, opts.audioTrackIndex, audioArgs, tmpPath);
      } catch (err) {
        await fs.rm(tmpPath, { force: true });
        throw err;
      }
      await fs.rename(tmpPath, outputPath);
      return outputPath;
    }

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
        // MKV chapters would otherwise become an extra MP4 text/data track,
        // which only gets in the receiver's way (we serve subtitles as VTT).
        "-map_chapters",
        "-1",
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

// Set once NVENC fails (no NVIDIA GPU, or a driver too old for this
// ffmpeg), so later burn-ins go straight to libx264 instead of failing first.
let nvencUnavailable = false;

/**
 * Re-encodes `entry` to H.264 with one ASS/SSA subtitle track rendered into
 * the picture by libass — drawings, fonts, positions, karaoke and all, which
 * a WebVTT text track can't carry (see assToVtt.ts). The track and the
 * file's embedded fonts are extracted into a scratch folder first and the
 * filter is given plain relative names from there: putting the original
 * path inside "-vf" would need filtergraph escaping for every ":", "\",
 * "[", "]", "," and "'" that Windows paths and release names are full of.
 * Encodes on the GPU (NVENC) when it can, falling back to libx264.
 */
async function burnSubtitles(
  entry: VideoEntry,
  subtitleIndex: number,
  audioTrackIndex: number,
  audioArgs: string[],
  outputPath: string
): Promise<void> {
  const workDir = outputPath.replace(/\.mp4$/, ".work");
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(path.join(workDir, "fonts"), { recursive: true });

  try {
    await runFfmpeg(["-y", "-i", entry.absolutePath, "-map", `0:s:${subtitleIndex}`, "-c:s", "copy", "-f", "ass", "sub.ass"], {
      cwd: workDir,
    });
    try {
      // Attachments are fonts, in practice. Each is written under a name of
      // our own: ffmpeg refuses to dump one whose stored filename it deems
      // "unsafe" (e.g. one with spaces), failing the whole dump. libass
      // identifies fonts by their contents, so the name doesn't matter.
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "t",
        "-show_entries",
        "stream_tags=filename",
        "-of",
        "json",
        entry.absolutePath,
      ]);
      const attachments: { tags?: { filename?: string } }[] = JSON.parse(stdout).streams ?? [];
      const dumpArgs = attachments.flatMap((a, i) => {
        const ext = path.extname(a.tags?.filename ?? "").toLowerCase();
        return [`-dump_attachment:t:${i}`, `font${i}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".ttf"}`];
      });
      if (dumpArgs.length) {
        await runFfmpeg(["-y", ...dumpArgs, "-i", entry.absolutePath, "-t", "0", "-f", "null", "-"], {
          cwd: path.join(workDir, "fonts"),
        });
      }
    } catch (err) {
      console.warn(`[burn] Couldn't extract the fonts of ${entry.relativePath}, using system fonts:`, (err as Error).message);
    }

    const encode = (gpu: boolean) =>
      runFfmpeg(
        [
          "-y",
          // Decoding on the GPU too roughly doubles throughput; frames come
          // back to system memory for libass since no output format is forced.
          ...(gpu ? ["-hwaccel", "cuda"] : []),
          "-i",
          entry.absolutePath,
          "-map",
          "0:v:0",
          "-map",
          `0:a:${audioTrackIndex}?`,
          // format=yuv420p: 8-bit output even from 10-bit sources (see getCachedRemux).
          "-vf",
          "subtitles=f=sub.ass:fontsdir=fonts,format=yuv420p",
          ...(gpu
            ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-profile:v", "high"]
            : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
          ...audioArgs,
          "-map_chapters",
          "-1",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          outputPath,
        ],
        { cwd: workDir }
      );

    const started = Date.now();
    if (!nvencUnavailable) {
      try {
        await encode(true);
        console.log(`[burn] ${entry.relativePath}: done on the GPU in ${Math.round((Date.now() - started) / 1000)}s`);
        return;
      } catch (err) {
        nvencUnavailable = true;
        console.warn("[burn] NVENC failed, using libx264 (CPU, much slower) from now on:", (err as Error).message.slice(-500));
      }
    }
    await encode(false);
    console.log(`[burn] ${entry.relativePath}: done on the CPU in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Returns the absolute path of the file that should be streamed for
 * playback: the original file when it's already compatible with the given
 * target, or a cached remux/transcode otherwise. The heavy work only
 * happens once per file version (keyed by id + mtime + size) and is cached
 * on disk indefinitely. Chromecast and browser playback are kept as
 * separate cache entries because a codec that's fine for one (HEVC on
 * Chromecast) can be unplayable on the other (HEVC in a desktop <video>).
 *
 * `burnSubtitleIndex` (an ASS/SSA track, see isBurnableSubtitle) renders
 * that track into the picture. That output is 8-bit H.264, which both
 * targets play, so it's one cache file shared by the two.
 */
export async function getPlayablePath(
  entry: VideoEntry,
  target: PlayTarget = "cast",
  audioTrackIndex = 0,
  burnSubtitleIndex: number | null = null
): Promise<{ path: string; contentType: string }> {
  if (burnSubtitleIndex !== null) {
    const audioCodec = audioTrackIndex === 0 ? entry.audioCodec : audioTrackCodec(entry, audioTrackIndex);
    return getCachedRemux(entry, {
      suffix: burnCacheSuffix(burnSubtitleIndex, audioTrackIndex),
      videoCopyOk: false,
      audioCopyOk: audioCodec ? AUDIO_COPY_CODECS.has(audioCodec.toLowerCase()) : true,
      targetLabel: "burned-in subtitles",
      audioTrackIndex,
      audioCodecLabel: audioCodec ?? "?",
      burnSubtitleIndex,
    });
  }

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
      videoCopyOk:
        !entry.videoHighBitDepth &&
        (entry.videoCodec ? BROWSER_VIDEO_COPY_CODECS.has(entry.videoCodec.toLowerCase()) : false),
      audioCopyOk: selectedAudioCodec ? AUDIO_COPY_CODECS.has(selectedAudioCodec.toLowerCase()) : true,
      targetLabel: "this browser",
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
    // HEVC Main 10 is fine on the TV, but 10-bit H.264 (Hi10P) has no
    // hardware decoder there, so that one is transcoded to 8-bit.
    videoCopyOk:
      !isHighBitDepthH264(entry) &&
      (entry.videoCodec ? VIDEO_COPY_CODECS.has(entry.videoCodec.toLowerCase()) : false),
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
  const codec = entry.subtitles.find((s) => s.index === subtitleIndex)?.codec.toLowerCase();
  // ASS/SSA goes through our own converter (see assToVtt.ts) instead of
  // ffmpeg's webvtt encoder. Its cache file gets its own "-ass" name so
  // tracks converted the old way are never reused.
  const isAss = codec === "ass" || codec === "ssa";
  const suffix = isAss ? `-sub${subtitleIndex}-ass` : `-sub${subtitleIndex}`;
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}${suffix}.vtt`);

  if (existsSync(outputPath)) return outputPath;

  return withDedupe(outputPath, async () => {
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}${suffix}.tmp.vtt`);
    if (isAss) {
      const tmpAssPath = path.join(config.cacheDir, `${cacheKey(entry)}${suffix}.tmp.ass`);
      try {
        await runFfmpeg(["-y", "-i", entry.absolutePath, "-map", `0:s:${subtitleIndex}`, "-c:s", "copy", "-f", "ass", tmpAssPath]);
        await fs.writeFile(tmpPath, assToVtt(await fs.readFile(tmpAssPath, "utf-8")), "utf-8");
      } finally {
        await fs.rm(tmpAssPath, { force: true });
      }
      await fs.rename(tmpPath, outputPath);
      return outputPath;
    }
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
    throw new Error(`"${entry.relativePath}" has no video track, so no thumbnail can be generated.`);
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
