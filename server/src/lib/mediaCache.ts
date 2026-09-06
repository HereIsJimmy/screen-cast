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
 * Returns the absolute path of the file that should be streamed to the TV:
 * the original file when it's already Chromecast-compatible, or a cached
 * remux/transcode otherwise. The heavy work only happens once per file
 * version (keyed by id + mtime + size) and is cached on disk indefinitely.
 */
export async function getPlayablePath(entry: VideoEntry): Promise<{ path: string; contentType: string }> {
  if (entry.directPlayCompatible) {
    return { path: entry.absolutePath, contentType: getStreamContentType(entry) };
  }

  await ensureCacheDir();
  const outputPath = path.join(config.cacheDir, `${cacheKey(entry)}.mp4`);

  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: "video/mp4" };
  }

  // Decide per-stream whether we can just copy (fast, lossless) or need to
  // re-encode, based on the codecs ffprobe already found — rather than
  // trying a blind stream-copy remux and reacting to failure, which for
  // audio codecs like AC3/DTS would "succeed" (many containers accept them)
  // while producing a file the TV still can't play.
  const videoCopyOk = entry.videoCodec ? VIDEO_COPY_CODECS.has(entry.videoCodec.toLowerCase()) : false;
  const audioCopyOk = entry.audioCodec ? AUDIO_COPY_CODECS.has(entry.audioCodec.toLowerCase()) : true;

  if ((!videoCopyOk || !audioCopyOk) && !config.allowTranscode) {
    throw new Error(
      `"${entry.relativePath}" usa códecs no compatibles con Chromecast ` +
        `(vídeo: ${entry.videoCodec ?? "?"}, audio: ${entry.audioCodec ?? "?"}) y ALLOW_TRANSCODE está desactivado.`
    );
  }

  await withDedupe(outputPath, async () => {
    // ffmpeg picks the container from the output filename's extension, so
    // the temp file must itself end in ".mp4" (a ".mp4.tmp" file confuses
    // it into refusing to guess a muxer) — the "in-progress" marker goes
    // *before* the extension instead. "-f mp4" below is a belt-and-braces
    // backup in case ffmpeg ever gets a weird extension again.
    const tmpPath = path.join(config.cacheDir, `${cacheKey(entry)}.tmp.mp4`);
    const videoArgs = videoCopyOk
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
    const audioArgs = audioCopyOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];

    try {
      await runFfmpeg([
        "-y",
        "-i",
        entry.absolutePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
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
