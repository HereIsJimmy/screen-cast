import { reactive, watch } from "vue";
import { setVideoWatched } from "@/services/api";
import { castState } from "@/services/cast";
import type { VideoDTO } from "@/types";

/** Share of a video that has to play before it counts as watched. */
const WATCHED_THRESHOLD = 0.6;

// Watched changes made from this page, on top of each VideoDTO's `watched`
// (which only refreshes on the next /api/library fetch). Reactive, so the
// library grid greys a card out the moment its video crosses the threshold,
// even with the popup closed (casting keeps going).
const overrides = reactive(new Map<string, boolean>());

// Ids already auto-marked from this page, so playback past the threshold
// doesn't PUT on every time update, and a video marked unwatched by hand
// isn't re-marked by the very playback that's still going.
const autoMarked = new Set<string>();

export function isVideoWatched(video: VideoDTO): boolean {
  return overrides.get(video.id) ?? video.watched;
}

export async function setWatched(id: string, watched: boolean): Promise<void> {
  const previous = overrides.get(id);
  overrides.set(id, watched); // optimistic
  try {
    await setVideoWatched(id, watched);
  } catch (err) {
    if (previous === undefined) overrides.delete(id);
    else overrides.set(id, previous);
    throw err;
  }
}

/** Marks `id` as watched once playback reaches WATCHED_THRESHOLD of its duration. */
export function trackWatchProgress(id: string, currentTimeSec: number, durationSec: number): void {
  if (autoMarked.has(id) || !(durationSec > 0) || currentTimeSec / durationSec < WATCHED_THRESHOLD) return;
  autoMarked.add(id);
  if (overrides.get(id) === true) return;
  setWatched(id, true).catch((err) => {
    autoMarked.delete(id); // try again on the next update
    console.warn("[watched] Couldn't mark the video as watched:", err);
  });
}

/** Tracks progress of whatever is casting. Call once, at app startup (works with the popup closed). */
export function setUpCastWatchTracking(): void {
  watch(
    () => castState.currentTimeSec,
    (time) => {
      if (castState.currentVideoId) trackWatchProgress(castState.currentVideoId, time, castState.durationSec);
    }
  );
}
