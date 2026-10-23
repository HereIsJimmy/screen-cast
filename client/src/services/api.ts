import type { PlaybackSettings, ServerInfo, SubtitleStyle, VideoDTO } from "@/types";

const API_BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Error ${res.status} on ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchLibrary(): Promise<{ videos: VideoDTO[]; includesOld: boolean }> {
  return request("/library");
}

export function fetchVideo(id: string): Promise<VideoDTO> {
  return request(`/videos/${id}`);
}

/** Deletes a video for good — removes the file on disk and its cached files. */
export function deleteVideo(id: string): Promise<{ deleted: boolean }> {
  return request(`/videos/${id}`, { method: "DELETE" });
}

/**
 * Re-scans the media folders. `includeOld` controls whether videos older
 * than the configured "recent" window are probed and indexed too (slower,
 * since ffprobe has to run on files that were previously skipped) or left
 * out of the index entirely (fast).
 */
export function rescanLibrary(
  includeOld: boolean
): Promise<{ count: number; errors: number; skipped: number; includesOld: boolean }> {
  return request(`/library/rescan?includeOld=${includeOld}`, { method: "POST" });
}

export function fetchServerInfo(): Promise<ServerInfo> {
  return request("/server-info");
}

/**
 * Shuts down the PC the server runs on (see server/.env's SHUTDOWN_ENABLED /
 * SHUTDOWN_PASSWORD). Only ever exposed in the UI when
 * serverInfo.shutdownEnabled is true — the server itself still enforces
 * both the flag and the password regardless.
 */
export function shutdownServerPc(password: string): Promise<{ ok: boolean }> {
  return request("/system/shutdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

interface StreamOptions {
  forBrowser?: boolean;
  audioTrackIndex?: number;
  /** ASS/SSA subtitle track rendered into the picture, or null for none. */
  burnSubtitleIndex?: number | null;
}

/**
 * Which subtitle track to burn into the picture: the selected one, when
 * burning in is on and it's an ASS/SSA track (VideoDTO subtitles' `burnable`),
 * otherwise none — other tracks are shown as regular text tracks.
 */
export function burnSubtitleIndexFor(video: VideoDTO, subtitleIndex: number | null, burnIn: boolean): number | null {
  if (!burnIn || subtitleIndex === null) return null;
  return video.subtitles.some((s) => s.index === subtitleIndex && s.burnable) ? subtitleIndex : null;
}

/**
 * Builds the `?target=browser&audio=N&burn=N` query string shared by prepareVideo
 * and videoStreamPath. `audioTrackIndex` is only included when explicitly
 * passed (checked with `!== undefined`, not truthiness — 0 is a valid,
 * meaningful track index): omitting it entirely means "use whichever track
 * the server considers the default" (see VideoDTO.defaultAudioTrackIndex),
 * which is what callers that don't offer an audio-track choice (e.g. the
 * library grid's "prepare ahead" button) rely on. `burnSubtitleIndex` works
 * the same way: undefined leaves it to the server (which burns in the
 * preselected track when it's ASS/SSA), null asks for no burn-in.
 */
function buildStreamQuery(opts?: StreamOptions): string {
  const params = new URLSearchParams();
  if (opts?.forBrowser) params.set("target", "browser");
  if (opts?.audioTrackIndex !== undefined) params.set("audio", String(opts.audioTrackIndex));
  if (opts?.burnSubtitleIndex !== undefined) params.set("burn", opts.burnSubtitleIndex === null ? "none" : String(opts.burnSubtitleIndex));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Resolves with the updated video (its browserReady/castReady reflect what was just prepared). */
export function prepareVideo(id: string, opts?: StreamOptions): Promise<{ ready: boolean; video: VideoDTO }> {
  return request(`/videos/${id}/prepare${buildStreamQuery(opts)}`, { method: "POST" });
}

/**
 * Deletes the cached remux behind a video's default stream for the browser
 * (or, without forBrowser, for casting), undoing prepareVideo. Resolves with
 * the updated video: a burned-in remux serves both, so both flags can change.
 */
export function deletePreparedVideo(
  id: string,
  opts?: { forBrowser?: boolean }
): Promise<{ removed: boolean; video: VideoDTO }> {
  const suffix = opts?.forBrowser ? "?target=browser" : "";
  return request(`/videos/${id}/prepared${suffix}`, { method: "DELETE" });
}

/**
 * Builds an absolute URL to a resource on this API, using the server's LAN
 * IP rather than the browser's current origin. The TV needs an address it
 * can actually reach — "localhost" or a dev-machine hostname it can't
 * resolve won't work — so every URL handed to the Cast SDK must go through
 * this helper.
 */
export function toAbsoluteMediaUrl(serverInfo: ServerInfo, path: string): string {
  return `${serverInfo.protocol}://${serverInfo.ip}:${serverInfo.port}/api${path}`;
}

/**
 * `forBrowser: true` asks the server for a stream this browser's own
 * <video> element can actually decode — notably, HEVC/H.265 plays fine on
 * Chromecast but not in most desktop browsers, so local playback needs a
 * separately-transcoded stream from the one handed to the Cast SDK.
 */
export function videoStreamPath(id: string, opts?: StreamOptions): string {
  return `/videos/${id}/stream${buildStreamQuery(opts)}`;
}

export function subtitlePath(id: string, index: number, opts?: { forBrowser?: boolean }): string {
  const suffix = opts?.forBrowser ? "?target=browser" : "";
  return `/videos/${id}/subtitles/${index}.vtt${suffix}`;
}

/** Relative URL for a video's thumbnail — same-origin, so no need for toAbsoluteMediaUrl here. */
export function thumbnailUrl(id: string): string {
  return `${API_BASE}/videos/${id}/thumbnail.jpg`;
}

/**
 * Same-origin relative URL for playing a stream/subtitle URL (from
 * videoStreamPath/subtitlePath) directly in *this* browser tab, e.g. a
 * native <video> element — as opposed to toAbsoluteMediaUrl, which is only
 * for handing a URL to the Cast SDK so the TV can fetch it independently.
 */
export function relativeMediaUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function fetchSubtitleStyle(): Promise<SubtitleStyle> {
  return request("/subtitle-style");
}

export function saveSubtitleStyle(style: SubtitleStyle): Promise<SubtitleStyle> {
  return request("/subtitle-style", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(style),
  });
}

/** Marks a video as watched or not; resolves with the updated video. */
export function setVideoWatched(id: string, watched: boolean): Promise<VideoDTO> {
  return request(`/videos/${id}/watched`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watched }),
  });
}

// Cached for the page's lifetime (savePlaybackSettings refreshes it), since
// every Cast/Play popup and queue step needs it before it can start.
let playbackSettings: Promise<PlaybackSettings> | null = null;

export function fetchPlaybackSettings(): Promise<PlaybackSettings> {
  playbackSettings ??= request<PlaybackSettings>("/playback-settings").catch((err) => {
    playbackSettings = null; // don't cache a failure
    throw err;
  });
  return playbackSettings;
}

export async function savePlaybackSettings(settings: PlaybackSettings): Promise<PlaybackSettings> {
  const saved = await request<PlaybackSettings>("/playback-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  playbackSettings = Promise.resolve(saved);
  return saved;
}
