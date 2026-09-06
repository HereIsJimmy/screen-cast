import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FfprobeResult } from "../types.js";

const execFileAsync = promisify(execFile);

let ffprobeChecked = false;
let ffprobeAvailable = false;

export async function checkFfprobeAvailable(): Promise<boolean> {
  if (ffprobeChecked) return ffprobeAvailable;
  try {
    await execFileAsync("ffprobe", ["-version"]);
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }
  ffprobeChecked = true;
  return ffprobeAvailable;
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `ffprobe` on a file and returns its parsed stream/format info.
 * Throws if ffprobe is missing or the file can't be read.
 */
export async function probeFile(absolutePath: string): Promise<FfprobeResult> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      absolutePath,
    ],
    { maxBuffer: 1024 * 1024 * 16 }
  );
  return JSON.parse(stdout) as FfprobeResult;
}
