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
    script.onerror = () => reject(new Error("No se pudo cargar el SDK de Google Cast."));
    document.head.appendChild(script);

    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (isAvailable) resolve();
      else reject(new Error("La API de Google Cast no está disponible en este navegador."));
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
        "Esta página no se está sirviendo por HTTPS. Google Cast solo funciona en un contexto seguro " +
        "(HTTPS o localhost) — ver README, sección HTTPS.";
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
        }
      }
    );
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
      castState.playerState = remotePlayer?.playerState ?? null;
    });
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => {
      castState.currentTimeSec = remotePlayer?.currentTime ?? 0;
    });
    remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.DURATION_CHANGED, () => {
      castState.durationSec = remotePlayer?.duration ?? 0;
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
      track.name = sub.title || sub.language || `Subtítulo ${sub.index + 1}`;
      track.language = sub.language ?? "";
      return track;
    });
}

/**
 * Starts (or takes over) a Cast session and tells the TV to load the given
 * video, with its subtitle tracks attached. `defaultSubtitleIndex` (the
 * server-side subtitle index, not the Cast trackId) is enabled immediately
 * if provided.
 */
export async function castVideo(
  serverInfo: ServerInfo,
  video: VideoDTO,
  defaultSubtitleIndex: number | null
): Promise<void> {
  await initializeCast();
  castState.error = null;

  const context = cast.framework.CastContext.getInstance();

  try {
    if (!context.getCurrentSession()) {
      await context.requestSession();
    }
  } catch (err) {
    // User closed the device-selection dialog, or no devices were found.
    castState.error = "No se pudo iniciar la sesión de cast (¿cancelaste el diálogo o no hay TVs cerca?).";
    throw err;
  }

  const session = context.getCurrentSession();
  if (!session) {
    castState.error = "No hay una sesión de cast activa.";
    return;
  }

  const contentUrl = toAbsoluteMediaUrl(serverInfo, videoStreamPath(video.id));
  const mediaInfo = new chrome.cast.media.MediaInfo(contentUrl, video.contentType);
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = video.title;
  mediaInfo.tracks = buildSubtitleTracks(serverInfo, video);

  let subtitleStyle: SubtitleStyle | null = null;
  try {
    subtitleStyle = await fetchSubtitleStyle();
    mediaInfo.textTrackStyle = buildTextTrackStyle(subtitleStyle);
    console.log("[cast] Estilo de subtítulos aplicado al cargar:", subtitleStyle);
  } catch (err) {
    console.warn("[cast] No se pudo cargar/aplicar el estilo de subtítulos, se usará el de la TV por defecto:", err);
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
}

export function togglePlayPause(): void {
  remotePlayerController?.playOrPause();
}

/**
 * Fully ends the Cast session (not just stops playback) — the receiver app
 * closes on the TV and `isConnected` goes back to false, so the library can
 * be cast to fresh afterwards. (`remotePlayerController.stop()` alone only
 * sends a STOP to the current media and leaves the session connected, which
 * is what caused "Detener" to look like it did nothing.)
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
    console.warn("[cast] No se pudo cargar el estilo de subtítulos al cambiar de pista:", err);
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
      castState.error = `No se pudo cambiar de subtítulo: ${err.description ?? err.code}`;
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
      "[cast] applySubtitleStyleLive: no hay ninguna reproducción cargada en la TV ahora mismo " +
        "(¿le diste a Detener, o aún no has casteado nada?) — el estilo se aplicará la próxima vez que castees."
    );
    return;
  }

  const activeTrackIds = castState.activeSubtitleIndex === null ? [] : [castState.activeSubtitleIndex + 1];
  const request = new chrome.cast.media.EditTracksInfoRequest(activeTrackIds, buildTextTrackStyle(style));

  await new Promise<void>((resolve, reject) => {
    media.editTracksInfo(
      request,
      () => {
        console.log("[cast] Estilo de subtítulos aplicado en directo:", style);
        resolve();
      },
      (err) => reject(new Error(err.description ?? String(err.code)))
    );
  });
}
