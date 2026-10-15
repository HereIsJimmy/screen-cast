import { reactive } from "vue";
import type { ServerInfo, SubtitleStyle, VideoDTO } from "@/types";
import { fetchSubtitleStyle, subtitlePath, toAbsoluteMediaUrl, videoStreamPath } from "@/services/api";

const SENDER_SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

export interface CastState {
  /** Whether the Cast Web Sender SDK finished loading in this browser. */
  sdkReady: boolean;
  /** Whether at least one Cast-capable device is available on the network. */
  hasCastDevices: boolean;
  /** Whether we currently have an active session with a TV. */
  isConnected: boolean;
  deviceName: string | null;
  playerState: string | null;
  currentTimeSec: number;
  durationSec: number;
  isMuted: boolean;
  activeSubtitleIndex: number | null;
  error: string | null;
  /**
   * Server-side id of the video currently loaded in the Cast session (not
   * just "is a session connected" — you can be connected to the TV while it
   * still has a *different* video loaded, e.g. right after navigating to
   * another video's page without having stopped the previous one).
   */
  currentVideoId: string | null;
}

export const castState: CastState = reactive({
  sdkReady: false,
  hasCastDevices: false,
  isConnected: false,
  deviceName: null,
  playerState: null,
  currentTimeSec: 0,
  durationSec: 0,
  isMuted: false,
  activeSubtitleIndex: null,
  error: null,
  currentVideoId: null,
});

let remotePlayer: cast.framework.RemotePlayer | null = null;

type FinishedListener = (videoId: string) => void;
const finishedListeners = new Set<FinishedListener>();

/**
 * Registers a callback for when the video on the TV plays through to its
 * end — not when it's stopped, replaced by another load, or the session
 * ends. Used by the queue to autoplay the next video. Returns an unsubscribe.
 */
export function onCastMediaFinished(listener: FinishedListener): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

/** How close to the end a stopped video still counts as "played to the end" when the TV gives no reason. */
const END_MARGIN_SEC = 10;

/** The video loaded by the last castVideo() call, tracked so its end is reported exactly once. */
interface CastLoad {
  videoId: string;
  endHandled: boolean;
  lastTimeSec: number;
  durationSec: number;
}
let currentLoad: CastLoad | null = null;

function endLoad(load: CastLoad, source: string, finished: boolean): void {
  if (load !== currentLoad || load.endHandled) return; // replaced by another load, or already handled
  load.endHandled = true;
  console.log(`[cast] Video ${load.videoId} stopped (${source}); ${finished ? "played to the end" : "not a natural end"}.`);
  if (!finished || castState.currentVideoId !== load.videoId) return;
  for (const listener of finishedListeners) listener(load.videoId);
}

/**
 * Decides whether a load that went IDLE played to its end. The receiver's
 * idleReason tells a real end (FINISHED) apart from stop/replace
 * (CANCELLED/INTERRUPTED) or ERROR, but it's often missing by the time the
 * sender sees the IDLE (the SDK drops the finished media session), so fall
 * back to "the last position seen was within a few seconds of the end".
 * The last position is tracked per load because the RemotePlayer's own
 * currentTime is usually reset to 0 by then.
 */
function judgeIdle(load: CastLoad, idleReason: string | null | undefined, source: string): void {
  if (idleReason === chrome.cast.media.IdleReason.FINISHED) {
    endLoad(load, `${source}: FINISHED`, true);
  } else if (idleReason) {
    endLoad(load, `${source}: ${idleReason}`, false);
  } else if (load.durationSec > 0 && load.lastTimeSec >= load.durationSec - END_MARGIN_SEC) {
    endLoad(load, `${source}: no reason, at ${Math.round(load.lastTimeSec)}/${Math.round(load.durationSec)} s`, true);
  }
}

function trackPosition(timeSec: number | undefined, durationSec: number | undefined): void {
  if (!currentLoad) return;
  if (timeSec && timeSec > 0) currentLoad.lastTimeSec = timeSec;
  if (durationSec && durationSec > 0) currentLoad.durationSec = durationSec;
}

/** Listens to the status updates of this load's own Media object (the most direct signal of its end). */
function watchForMediaEnd(media: chrome.cast.media.Media, load: CastLoad): void {
  media.addUpdateListener((isAlive) => {
    if (load !== currentLoad) return;
    if (media.playerState === chrome.cast.media.PlayerState.PLAYING) {
      trackPosition(media.getEstimatedTime(), media.media?.duration ?? undefined);
    }
    if (!isAlive || media.playerState === chrome.cast.media.PlayerState.IDLE) {
      console.log(`[cast] Media status: ${media.playerState}, reason=${media.idleReason ?? "none"}, alive=${isAlive}`);
      judgeIdle(load, media.idleReason, "media status");
    }
  });
}

let remotePlayerController: cast.framework.RemotePlayerController | null = null;
let initPromise: Promise<void> | null = null;

function loadSdkScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${SENDER_SDK_URL}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = SENDER_SDK_URL;
    script.onerror = () => reject(new Error("Couldn't load the Google Cast SDK."));
    document.head.appendChild(script);

    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (isAvailable) resolve();
      else reject(new Error("The Google Cast API isn't available in this browser."));
    };
  });
}

/**
 * Loads the Cast SDK and initializes the CastContext. Safe to call multiple
 * times — subsequent calls reuse the same initialization.
 *
 * Requires a secure context (HTTPS or localhost); see README.
 */
export function initializeCast(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!window.isSecureContext) {
      castState.error =
        "This page isn't being served over HTTPS. Google Cast only works in a secure context " +
        "(HTTPS or localhost) — see the README, HTTPS section.";
    }

    await loadSdkScript();

    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    castState.sdkReady = true;

    context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
      castState.hasCastDevices = event.castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
      castState.isConnected = event.castState === cast.framework.CastState.CONNECTED;
    });

    remotePlayer = new cast.framework.RemotePlayer();
    remotePlayerController = new cast.framework.RemotePlayerController(remotePlayer);

    remotePlayerController.addEventListener(
      cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
      () => {
        castState.isConnected = remotePlayer?.isConnected ?? false;
        const session = context.getCurrentSession();
        castState.deviceName = session?.getCastDevice()?.friendlyName ?? null;
        if (!castState.isConnected) {
          castState.playerState = null;
          castState.currentTimeSec = 0;
          castState.durationSec = 0;
          castState.currentVideoId = null;
          castState.activeSubtitleIndex = null;
          currentLoad = null;
        }
      }
    );
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
      const previous = castState.playerState;
      castState.playerState = remotePlayer?.playerState ?? null;

      // Backup for the per-load media listener: playback stopped (IDLE, or
      // the player state cleared) after it had been playing.
      const stopped =
        castState.playerState === null || castState.playerState === chrome.cast.media.PlayerState.IDLE;
      const wasActive = previous !== null && previous !== chrome.cast.media.PlayerState.IDLE;
      if (stopped && wasActive && currentLoad) {
        const media = context.getCurrentSession()?.getMediaSession();
        console.log(`[cast] Player state: ${previous} → ${castState.playerState}, reason=${media?.idleReason ?? "none"}`);
        judgeIdle(currentLoad, media?.idleReason, "player state");
      }
    });
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => {
      castState.currentTimeSec = remotePlayer?.currentTime ?? 0;
      trackPosition(castState.currentTimeSec, undefined);
    });
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.DURATION_CHANGED, () => {
      castState.durationSec = remotePlayer?.duration ?? 0;
      trackPosition(undefined, castState.durationSec);
    });
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.IS_MUTED_CHANGED, () => {
      castState.isMuted = remotePlayer?.isMuted ?? false;
    });
  })();

  return initPromise;
}

/** Maps our plain-JSON SubtitleStyle into a real Cast SDK TextTrackStyle instance. */
function buildTextTrackStyle(style: SubtitleStyle): chrome.cast.media.TextTrackStyle {
  const s = new chrome.cast.media.TextTrackStyle();
  s.fontScale = style.fontScale;
  s.fontStyle = chrome.cast.media.TextTrackFontStyle[style.fontStyle];
  s.fontGenericFamily = chrome.cast.media.TextTrackFontGenericFamily[style.fontGenericFamily];
  s.foregroundColor = style.foregroundColor;
  s.backgroundColor = style.backgroundColor;
  s.edgeType = chrome.cast.media.TextTrackEdgeType[style.edgeType];
  s.edgeColor = style.edgeColor;
  s.windowType = chrome.cast.media.TextTrackWindowType[style.windowType];
  s.windowColor = style.windowColor;
  s.windowRoundedCornerRadius = style.windowRoundedCornerRadius;
  return s;
}

function buildSubtitleTracks(serverInfo: ServerInfo, video: VideoDTO): chrome.cast.media.Track[] {
  return video.subtitles
    .filter((sub) => !sub.unsupported)
    .map((sub) => {
      const trackId = sub.index + 1; // Cast track ids must be positive integers.
      const track = new chrome.cast.media.Track(trackId, chrome.cast.media.TrackType.TEXT);
      track.trackContentId = toAbsoluteMediaUrl(serverInfo, subtitlePath(video.id, sub.index));
      track.trackContentType = "text/vtt";
      track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
      track.name = sub.title || sub.language || `Subtitle ${sub.index + 1}`;
      track.language = sub.language ?? "";
      return track;
    });
}

/** Whether the page still counts as "responding to a click" (Chrome's transient user activation). */
function hasUserActivation(): boolean {
  // navigator.userActivation is missing in older browsers; assume yes there
  // and let Chrome decide.
  return navigator.userActivation?.isActive ?? true;
}

function sessionErrorMessage(code: string): string {
  switch (code) {
    case chrome.cast.ErrorCode.CANCEL:
      return "Casting was cancelled (the TV selection dialog was closed).";
    case chrome.cast.ErrorCode.RECEIVER_UNAVAILABLE:
      return "No TVs/Chromecasts were found on your network.";
    case chrome.cast.ErrorCode.TIMEOUT:
      return "The TV didn't respond in time. Click Cast again.";
    default:
      return `Couldn't start the cast session (${code}). Click Cast again.`;
  }
}

/**
 * Returns the current Cast session, opening Chrome's TV selection dialog
 * first if there isn't one. Call this straight from a click handler,
 * *before* any slow work (like preparing the video): Chrome only opens the
 * dialog while the page still has "user activation" from the click, which
 * expires after a few seconds — awaiting a long remux first is what made
 * the dialog sometimes never appear and the request time out instead.
 *
 * Retries once on failures other than the user closing the dialog, but
 * only while the click still counts: a retry without user activation can't
 * open the dialog either, so it would just fail again.
 */
export async function ensureCastSession(): Promise<cast.framework.CastSession> {
  await initializeCast();
  castState.error = null;

  const context = cast.framework.CastContext.getInstance();
  const existing = context.getCurrentSession();
  if (existing) return existing;

  for (let attempt = 1; ; attempt++) {
    try {
      await context.requestSession();
      break;
    } catch (err) {
      // requestSession rejects with a chrome.cast.ErrorCode string.
      const code = typeof err === "string" ? err : String((err as { code?: string })?.code ?? err);
      console.warn(`[cast] requestSession failed (attempt ${attempt}): ${code}`);
      if (attempt < 2 && code !== chrome.cast.ErrorCode.CANCEL && hasUserActivation()) continue;
      castState.error = sessionErrorMessage(code);
      throw new Error(castState.error);
    }
  }

  const session = context.getCurrentSession();
  if (!session) {
    castState.error = "There's no active cast session.";
    throw new Error(castState.error);
  }
  return session;
}

/**
 * Starts (or takes over) a Cast session and tells the TV to load the given
 * video, with its subtitle tracks attached. `defaultSubtitleIndex` (the
 * server-side subtitle index, not the Cast trackId) is enabled immediately
 * if provided. `audioTrackIndex` (the server-side audio track index, 0 by
 * default) picks which embedded audio stream the server bakes into the
 * remux the content URL points at — there's no Cast-side mechanism to
 * switch embedded audio tracks mid-session, so this only takes effect at
 * load time.
 */
export async function castVideo(
  serverInfo: ServerInfo,
  video: VideoDTO,
  defaultSubtitleIndex: number | null,
  audioTrackIndex = 0
): Promise<void> {
  const session = await ensureCastSession();

  const contentUrl = toAbsoluteMediaUrl(serverInfo, videoStreamPath(video.id, { audioTrackIndex }));
  const mediaInfo = new chrome.cast.media.MediaInfo(contentUrl, video.contentType);
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = video.title;
  mediaInfo.tracks = buildSubtitleTracks(serverInfo, video);

  let subtitleStyle: SubtitleStyle | null = null;
  try {
    subtitleStyle = await fetchSubtitleStyle();
    mediaInfo.textTrackStyle = buildTextTrackStyle(subtitleStyle);
    console.log("[cast] Subtitle style applied on load:", subtitleStyle);
  } catch (err) {
    console.warn("[cast] Couldn't load/apply the subtitle style, the TV's default will be used:", err);
  }

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  if (defaultSubtitleIndex !== null) {
    request.activeTrackIds = [defaultSubtitleIndex + 1];
    castState.activeSubtitleIndex = defaultSubtitleIndex;
  } else {
    castState.activeSubtitleIndex = null;
  }

  await session.loadMedia(request);
  castState.currentVideoId = video.id;
  const load: CastLoad = { videoId: video.id, endHandled: false, lastTimeSec: 0, durationSec: video.durationSec ?? 0 };
  currentLoad = load;
  const media = session.getMediaSession();
  if (media) watchForMediaEnd(media, load);
  else console.warn("[cast] No media session after load; queue autoplay won't trigger for this video.");
}

export function togglePlayPause(): void {
  remotePlayerController?.playOrPause();
}

/**
 * Fully ends the Cast session (not just stops playback) — the receiver app
 * closes on the TV and `isConnected` goes back to false, so the library can
 * be cast to fresh afterwards. (`remotePlayerController.stop()` alone only
 * sends a STOP to the current media and leaves the session connected, which
 * is what caused "Stop" to look like it did nothing.)
 */
export function stopCasting(): void {
  cast.framework.CastContext.getInstance().endCurrentSession(true);
}

export function seekTo(seconds: number): void {
  if (!remotePlayer) return;
  remotePlayer.currentTime = seconds;
  remotePlayerController?.seek();
}

export function setVolume(level: number): void {
  if (!remotePlayer) return;
  remotePlayer.volumeLevel = level;
  remotePlayerController?.setVolumeLevel();
}

export function toggleMute(): void {
  remotePlayerController?.muteOrUnmute();
}

/** Switches the active subtitle track (server-side subtitle index), or turns subtitles off. */
export async function setSubtitleTrack(video: VideoDTO, subtitleIndex: number | null): Promise<void> {
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  const media = session?.getMediaSession();
  if (!media) return;

  const activeTrackIds = subtitleIndex === null ? [] : [subtitleIndex + 1];
  let subtitleStyle: SubtitleStyle | null = null;
  try {
    subtitleStyle = await fetchSubtitleStyle();
  } catch (err) {
    console.warn("[cast] Couldn't load the subtitle style when switching tracks:", err);
  }
  const request = new chrome.cast.media.EditTracksInfoRequest(
    activeTrackIds,
    subtitleStyle ? buildTextTrackStyle(subtitleStyle) : undefined
  );
  media.editTracksInfo(
    request,
    () => {
      castState.activeSubtitleIndex = subtitleIndex;
    },
    (err) => {
      castState.error = `Couldn't switch subtitles: ${err.description ?? err.code}`;
    }
  );
}

/**
 * Re-applies the subtitle style to whatever is currently casting, without
 * changing which track is active. Used by the settings page so a style
 * change shows up live on the TV if something is already playing — a no-op
 * if nothing is casting right now (the new style still applies next time
 * castVideo() runs, since that always fetches the latest saved style).
 */
export async function applySubtitleStyleLive(style: SubtitleStyle): Promise<void> {
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  const media = session?.getMediaSession();
  if (!media) {
    console.warn(
      "[cast] applySubtitleStyleLive: nothing is loaded on the TV right now " +
        "(did you click Stop, or haven't you cast anything yet?) — the style will apply the next time you cast."
    );
    return;
  }

  const activeTrackIds = castState.activeSubtitleIndex === null ? [] : [castState.activeSubtitleIndex + 1];
  const request = new chrome.cast.media.EditTracksInfoRequest(activeTrackIds, buildTextTrackStyle(style));

  await new Promise<void>((resolve, reject) => {
    media.editTracksInfo(
      request,
      () => {
        console.log("[cast] Subtitle style applied live:", style);
        resolve();
      },
      (err) => reject(new Error(err.description ?? String(err.code)))
    );
  });
}
