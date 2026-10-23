import fs from "node:fs/promises";
import { Router } from "express";
import { getEntry, toDTO } from "../lib/library.js";
import {
  defaultBurnSubtitleIndex,
  deletePreparedCache,
  getPlayablePath,
  getSubtitleVttPath,
  getThumbnailPath,
  isBurnableSubtitle,
  type PlayTarget,
} from "../lib/mediaCache.js";
import { sendFileWithRange } from "../lib/rangeStream.js";
import { readSubtitleStyle } from "../lib/subtitleStyle.js";
import { applyCuePosition, buildCueStyleBlock, injectCueStyle } from "../lib/subtitleVtt.js";
import type { VideoEntry } from "../types.js";

export const streamRouter = Router();

/** Reads the ?target=browser|cast query param used by /prepare and /stream. */
function getPlayTarget(req: { query: { target?: unknown } }): PlayTarget {
  return req.query.target === "browser" ? "browser" : "cast";
}

/**
 * Reads the ?audio=N query param used by /prepare and /stream, falling back
 * to the entry's own default (entry.defaultAudioTrackIndex — see
 * pickDefaultAudioTrackIndex in library.ts) when it's missing or doesn't
 * name a real audio track on this video — mirrors getPlayTarget above.
 */
function getAudioTrackIndex(req: { query: { audio?: unknown } }, entry: VideoEntry): number {
  const raw = Number(req.query.audio);
  if (Number.isInteger(raw) && raw >= 0 && entry.audioTracks.some((t) => t.index === raw)) {
    return raw;
  }
  return entry.defaultAudioTrackIndex;
}

/**
 * Reads the ?burn=N|none query param used by /prepare and /stream: which
 * ASS/SSA subtitle track to burn into the picture, or "none". Missing (or
 * naming a track that can't be burned) falls back to the server's default,
 * which burns the preselected subtitle track when it's ASS/SSA — so callers
 * that offer no choice (the library's "prepare" button, queue autoplay) get
 * the same file the popups use by default. Mirrors getAudioTrackIndex.
 */
function getBurnSubtitleIndex(req: { query: { burn?: unknown } }, entry: VideoEntry): number | null {
  if (req.query.burn === "none") return null;
  const raw = Number(req.query.burn);
  if (req.query.burn !== undefined && Number.isInteger(raw) && isBurnableSubtitle(entry, raw)) return raw;
  return defaultBurnSubtitleIndex(entry);
}

/**
 * Kicks off (and waits for) remux/subtitle-extraction for a video, so the
 * client can show a "preparing…" state before actually telling the TV to
 * load the stream URL. Idempotent and safe to call more than once.
 */
streamRouter.post("/videos/:id/prepare", async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  try {
    await getPlayablePath(entry, getPlayTarget(req), getAudioTrackIndex(req, entry), getBurnSubtitleIndex(req, entry));
    const supportedSubs = entry.subtitles.filter((s) => !s.unsupported);
    await Promise.all(supportedSubs.map((s) => getSubtitleVttPath(entry, s.index)));
    // The updated video lets the library grid refresh both prepare buttons
    // (a burned-in remux serves both targets).
    res.json({ ready: true, video: toDTO(entry) });
  } catch (err) {
    res.status(500).json({ ready: false, error: (err as Error).message });
  }
});

/**
 * Un-prepares a video for ?target (browser or cast): deletes the cached
 * remux/transcode behind its prepare button in the library grid (or, for a
 * video that never needed a cache file, simply reports nothing was removed
 * and stays ready). Returns the updated video too: deleting a burned-in
 * remux un-prepares both targets at once.
 */
streamRouter.delete("/videos/:id/prepared", async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  try {
    const { removed } = await deletePreparedCache(entry, getPlayTarget(req));
    res.json({ removed, video: toDTO(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

streamRouter.get("/videos/:id/stream", async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  try {
    const { path: filePath, contentType } = await getPlayablePath(
      entry,
      getPlayTarget(req),
      getAudioTrackIndex(req, entry),
      getBurnSubtitleIndex(req, entry)
    );
    sendFileWithRange(req, res, filePath, contentType);
  } catch (err) {
    console.error(`[stream] Error preparing ${entry.relativePath}:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

streamRouter.get("/videos/:id/thumbnail.jpg", async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).end();
    return;
  }

  try {
    const thumbPath = await getThumbnailPath(entry);
    sendFileWithRange(req, res, thumbPath, "image/jpeg");
  } catch (err) {
    // Not fatal — the client just shows a placeholder icon when this 404s.
    console.warn(`[stream] Couldn't generate a thumbnail for ${entry.relativePath}:`, (err as Error).message);
    res.status(404).end();
  }
});

streamRouter.get("/videos/:id/subtitles/:index.vtt", async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const subtitleIndex = Number(req.params.index);
  const track = entry.subtitles.find((s) => s.index === subtitleIndex);
  if (!track || track.unsupported) {
    res.status(404).json({ error: "Subtitle track not available" });
    return;
  }

  try {
    const vttPath = await getSubtitleVttPath(entry, subtitleIndex);
    const [raw, style] = await Promise.all([fs.readFile(vttPath, "utf-8"), readSubtitleStyle()]);
    let vtt = applyCuePosition(raw, style.subtitlePositionPercent);
    // Appearance (font/color/edge/background) only makes sense for a plain
    // <video> — Chromecast ignores WebVTT STYLE blocks and gets its look
    // from TextTrackStyle instead (see castVideo in services/cast.ts), so
    // this is skipped there rather than sending CSS a receiver won't use.
    if (getPlayTarget(req) === "browser") {
      vtt = injectCueStyle(vtt, buildCueStyleBlock(style));
    }
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);
  } catch (err) {
    console.error(`[stream] Error extracting subtitles from ${entry.relativePath}:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});
