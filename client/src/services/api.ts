import type { ServerInfo, SubtitleStyle, VideoDTO } from "@/types";

const API_BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Error ${res.status} en ${path}`);
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

export function prepareVideo(id: string, opts?: { forBrowser?: boolean }): Promise<{ ready: boolean }> {
  const suffix = opts?.forBrowser ? "?target=browser" : "";
  return request(`/videos/${id}/prepare${suffix}`, { method: "POST" });
}

/** Deletes a video's cached browser remux, undoing prepareVideo({ forBrowser: true }). */
export function deletePreparedVideo(id: string, opts?: { forBrowser?: boolean }): Promise<{ removed: boolean }> {
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
export function videoStreamPath(id: string, opts?: { forBrowser?: boolean }): string {
  const suffix = opts?.forBrowser ? "?target=browser" : "";
  return `/videos/${id}/stream${suffix}`;
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
