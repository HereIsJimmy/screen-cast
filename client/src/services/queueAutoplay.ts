import { watch } from "vue";
import { router } from "@/router";
import { fetchServerInfo, fetchVideo, prepareVideo } from "@/services/api";
import { castState, castVideo, onCastMediaFinished } from "@/services/cast";
import { peekNext, removeFromQueue, takeNext } from "@/services/queue";

/**
 * Starts preparing the next queued video in the background, so autoplay
 * doesn't sit on a remux/transcode when the current one ends. Best-effort:
 * if it fails, autoplay just prepares it again (and reports the error then).
 */
export function prepareNextInBackground(opts: { forBrowser?: boolean } = {}): void {
  const next = peekNext();
  if (!next) return;
  prepareVideo(next.id, opts).catch((err) => {
    console.warn(`[queue] Couldn't prepare "${next.title}" ahead of time:`, err);
  });
}

let advancing = false;

/**
 * Casts the next queued video once the one on the TV finishes. Lives here,
 * not in the Cast popup, so it keeps going with the popup closed (as long
 * as this page stays open). Skips queued videos that no longer exist.
 */
async function castNextFromQueue(): Promise<void> {
  if (advancing) return;
  advancing = true;
  try {
    if (!peekNext()) {
      console.log("[queue] Video finished; the queue is empty.");
      return;
    }
    const serverInfo = await fetchServerInfo();
    for (let next = takeNext(); next; next = takeNext()) {
      console.log(`[queue] Video finished; casting "${next.title}".`);
      try {
        const video = await fetchVideo(next.id);
        await prepareVideo(video.id, { audioTrackIndex: video.defaultAudioTrackIndex });
        await castVideo(serverInfo, video, video.defaultSubtitleIndex, video.defaultAudioTrackIndex);
        return;
      } catch (err) {
        console.warn(`[queue] Skipping "${next.title}":`, err);
      }
    }
  } catch (err) {
    castState.error = `Couldn't play the next queued video: ${(err as Error).message}`;
  } finally {
    advancing = false;
  }
}

/** Wires up queue autoplay for casting. Call once, at app startup. */
export function setUpCastQueueAutoplay(): void {
  onCastMediaFinished(() => {
    castNextFromQueue();
  });

  watch(
    () => castState.currentVideoId,
    (videoId, previousId) => {
      if (!videoId) return;
      // Whatever is playing now is no longer "up next".
      removeFromQueue(videoId);
      prepareNextInBackground();

      // If the Cast popup is showing the video that just finished, follow
      // along to the one that replaced it.
      const route = router.currentRoute.value;
      if (route.name === "player" && previousId && route.params.id === previousId) {
        router.replace({ name: "player", params: { id: videoId }, query: route.query });
      }
    }
  );
}
