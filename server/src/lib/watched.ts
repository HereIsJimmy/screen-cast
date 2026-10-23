import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Which videos have been watched (the client marks one once 60% of it has
 * played, on the TV or in the browser), keyed by video id — which comes
 * from the relative path, so it survives rescans. Stored server-side rather
 * than per device so the phone and the PC agree. File shape:
 * { "<id>": <ms timestamp when marked> }.
 */

function getWatchedPath(): string {
  return path.join(config.dataDir, "watched.json");
}

// In memory for the same reason as playbackSettings.ts: toDTO needs it synchronously.
let watched: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (watched) return watched;
  watched = new Map();
  const watchedPath = getWatchedPath();
  if (existsSync(watchedPath)) {
    try {
      const raw = JSON.parse(readFileSync(watchedPath, "utf-8")) as Record<string, unknown>;
      for (const [id, at] of Object.entries(raw)) {
        if (typeof at === "number") watched.set(id, at);
      }
    } catch (err) {
      console.warn(`[watched] Couldn't read ${watchedPath}, starting empty:`, (err as Error).message);
    }
  }
  return watched;
}

export function isWatched(id: string): boolean {
  return load().has(id);
}

export async function setWatched(id: string, value: boolean): Promise<void> {
  const map = load();
  if (value === map.has(id)) return;
  if (value) map.set(id, Date.now());
  else map.delete(id);
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(getWatchedPath(), JSON.stringify(Object.fromEntries(map), null, 2), "utf-8");
}
