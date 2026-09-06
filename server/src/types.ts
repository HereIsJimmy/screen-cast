export interface SubtitleTrackInfo {
  /** Position among subtitle streams only (0-based). Matches ffmpeg's `-map 0:s:{index}`. */
  index: number;
  language?: string;
  title?: string;
  codec: string;
  /** True when the codec is a bitmap format (PGS/VobSub/DVB) we cannot convert to WebVTT text. */
  unsupported: boolean;
}

export interface VideoEntry {
  /** Stable id derived from the file's relative path. */
  id: string;
  /** Absolute path on disk. Never sent to the client. */
  absolutePath: string;
  /** Path relative to its media root, used as the display title source. */
  relativePath: string;
  title: string;
  sizeBytes: number;
  mtimeMs: number;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  containerExt: string;
  /** True when the file can be sent to the TV as-is (compatible container + codecs). */
  directPlayCompatible: boolean;
  subtitles: SubtitleTrackInfo[];
}

export interface VideoDTO {
  id: string;
  title: string;
  relativePath: string;
  /** File's last-modified time, used by the client's "recent videos" filter. */
  mtimeMs: number;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  contentType: string;
  needsProcessing: boolean;
  subtitles: {
    index: number;
    language?: string;
    title?: string;
    unsupported: boolean;
  }[];
}

export interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: Record<string, string>;
}

export interface FfprobeFormat {
  duration?: string;
  format_name?: string;
}

export interface FfprobeResult {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export interface PreparedVideo {
  /** Absolute path of the file that should actually be streamed to the TV. */
  streamPath: string;
  contentType: string;
}

/**
 * Mirrors Google Cast's chrome.cast.media.TextTrackStyle fields (as plain
 * JSON, so it round-trips through the API and gets hydrated into a real
 * TextTrackStyle instance client-side). Colors are "#RRGGBBAA" hex strings.
 */
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
   * (0 = top edge, 100 = bottom edge). Cast's TextTrackStyle has no notion
   * of position, so this isn't sent to the receiver directly — instead the
   * server rewrites each cue's WebVTT "line:" setting when serving the
   * .vtt file. That means, unlike the other style fields, a position change
   * only takes effect the next time the track is (re)loaded, not live.
   */
  subtitlePositionPercent: number;
}
