export interface SubtitleTrackDTO {
  index: number;
  language?: string;
  title?: string;
  unsupported: boolean;
}

export interface VideoDTO {
  id: string;
  title: string;
  relativePath: string;
  mtimeMs: number;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  contentType: string;
  needsProcessing: boolean;
  subtitles: SubtitleTrackDTO[];
}

export interface ServerInfo {
  ip: string;
  /** Plain HTTP port — always what video/subtitle/thumbnail URLs use (the TV fetches those directly). */
  port: number;
  protocol: "http";
  /** Extra HTTPS listener for opening the web UI itself as a secure context (e.g. from a phone), or null if not configured. Never used to build media URLs. */
  httpsPort: number | null;
  recentMonths: number;
}

/** Mirrors chrome.cast.media.TextTrackStyle — see services/cast.ts for how it's applied. */
export interface SubtitleStyle {
  fontScale: number;
  fontStyle: "NORMAL" | "BOLD" | "ITALIC" | "BOLD_ITALIC";
  fontGenericFamily:
    | "CASUAL"
    | "CURSIVE"
    | "MONOSPACED_SANS_SERIF"
    | "MONOSPACED_SERIF"
    | "SANS_SERIF"
    | "SERIF"
    | "SMALL_CAPITALS";
  foregroundColor: string;
  backgroundColor: string;
  edgeType: "NONE" | "OUTLINE" | "DROP_SHADOW" | "RAISED" | "DEPRESSED";
  edgeColor: string;
  windowType: "NONE" | "NORMAL" | "ROUNDED_CORNERS";
  windowColor: string;
  windowRoundedCornerRadius: number;
  /**
   * Vertical position of the subtitles as a percentage of the video height
   * (0 = top, 100 = bottom). Not part of Cast's TextTrackStyle — the server
   * applies it by rewriting the WebVTT cue "line:" setting, so unlike the
   * other fields it only takes effect the next time the track loads.
   */
  subtitlePositionPercent: number;
}
