import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { PlaybackSettings } from "../types.js";

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  burnInByDefault: true,
};

function getSettingsPath(): string {
  return path.join(config.dataDir, "playback-settings.json");
}

function sanitizePlaybackSettings(input: unknown): PlaybackSettings {
  const out: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
  if (!input || typeof input !== "object") return out;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.burnInByDefault === "boolean") out.burnInByDefault = candidate.burnInByDefault;
  return out;
}

// Kept in memory (read once, updated on save) because it's needed
// synchronously: defaultBurnSubtitleIndex in mediaCache.ts runs for every
// video while building the library listing.
let current: PlaybackSettings | null = null;

export function getPlaybackSettings(): PlaybackSettings {
  if (current) return current;
  const settingsPath = getSettingsPath();
  current = { ...DEFAULT_PLAYBACK_SETTINGS };
  if (existsSync(settingsPath)) {
    try {
      current = sanitizePlaybackSettings(JSON.parse(readFileSync(settingsPath, "utf-8")));
    } catch (err) {
      console.warn(`[playbackSettings] Couldn't read ${settingsPath}, using defaults:`, (err as Error).message);
    }
  }
  return current;
}

export async function writePlaybackSettings(input: unknown): Promise<PlaybackSettings> {
  const settings = sanitizePlaybackSettings(input);
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  current = settings;
  return settings;
}
