import type { SubtitleStyle } from "../types.js";

/**
 * WebVTT doesn't have a "global default position" — each cue's timing line
 * can carry its own settings (align, position, line, ...). Cast's
 * TextTrackStyle API has no position field either, so to let the user move
 * subtitles up/down we rewrite every cue's "line:" setting when serving the
 * .vtt file, based on the saved style. This runs on every request rather
 * than being baked into the cached extraction, so a position change takes
 * effect the next time the TV (re)fetches the track without needing to
 * re-extract anything.
 */

const CUE_TIMING_RE = /^(\d{2}:\d{2}:\d{2}\.\d{3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}\.\d{3})(.*)$/;

export function applyCuePosition(vttText: string, linePercent: number): string {
  const clamped = Math.min(100, Math.max(0, Math.round(linePercent)));
  return vttText
    .split(/\r\n|\n/)
    .map((line) => {
      const match = CUE_TIMING_RE.exec(line);
      if (!match) return line;
      const [, start, arrow, end, rest] = match;
      // Drop any existing line:xx% / line:N setting so ours is the one that applies.
      const otherSettings = (rest ?? "").replace(/\bline:\S+/g, "").trim();
      const settings = otherSettings ? `${otherSettings} line:${clamped}%` : `line:${clamped}%`;
      return `${start}${arrow}${end} ${settings}`;
    })
    .join("\n");
}

// Mirrors client/src/views/SettingsView.vue's preview mapping exactly, so
// what the user sees in the Settings preview is what actually renders in
// the browser player — just expressed as WebVTT `::cue` CSS instead of
// inline Vue styles. 8-digit "#RRGGBBAA" hex (how SubtitleStyle stores
// every color) is valid CSS as-is, so the stored strings are used directly.
const FONT_FAMILY_CSS: Record<SubtitleStyle["fontGenericFamily"], string> = {
  SANS_SERIF: "system-ui, sans-serif",
  SMALL_CAPITALS: "system-ui, sans-serif",
  CASUAL: "system-ui, sans-serif",
  SERIF: "Georgia, 'Times New Roman', serif",
  MONOSPACED_SANS_SERIF: "'Courier New', monospace",
  MONOSPACED_SERIF: "'Courier New', monospace",
  CURSIVE: "'Comic Sans MS', cursive",
};

const EDGE_SHADOW: Record<SubtitleStyle["edgeType"], (color: string) => string> = {
  NONE: () => "none",
  OUTLINE: (c) => `-1px -1px 0 ${c}, 1px -1px 0 ${c}, -1px 1px 0 ${c}, 1px 1px 0 ${c}`,
  DROP_SHADOW: (c) => `2px 2px 3px ${c}`,
  RAISED: (c) => `-1px -1px 1px ${c}`,
  DEPRESSED: (c) => `1px 1px 1px ${c}`,
};

/**
 * Builds a WebVTT `STYLE` block body targeting `::cue`, from the same
 * SubtitleStyle the Settings page saves and the Cast target sends as a
 * TextTrackStyle. Only meaningful for browser playback — a plain <video>
 * with a <track> honors `::cue` natively; Chromecast's receiver doesn't use
 * it at all (it applies TextTrackStyle itself), which is why this is only
 * wired up for target=browser in routes/stream.ts.
 */
export function buildCueStyleBlock(style: SubtitleStyle): string {
  const fontWeight = style.fontStyle === "BOLD" || style.fontStyle === "BOLD_ITALIC" ? "bold" : "normal";
  const fontStyleCss = style.fontStyle === "ITALIC" || style.fontStyle === "BOLD_ITALIC" ? "italic" : "normal";
  const fontVariant = style.fontGenericFamily === "SMALL_CAPITALS" ? "small-caps" : "normal";
  // The window (a box around the whole cue) and the plain background (a
  // tight per-line highlight) are two different things in Cast's model;
  // `::cue` only gives us one background, so when a window is enabled it
  // wins — that's the more visually prominent choice, and it's how the
  // window/background pair is typically used (one or the other, not both).
  const background = style.windowType === "NONE" ? style.backgroundColor : style.windowColor;
  const borderRadius = style.windowType === "ROUNDED_CORNERS" ? `${style.windowRoundedCornerRadius}px` : "0px";

  return [
    "::cue {",
    `  font-family: ${FONT_FAMILY_CSS[style.fontGenericFamily]};`,
    // fontScale is already a plain multiplier (shown as "1.5×" etc. in
    // Settings) — em keeps it relative to the browser's own UA-computed
    // default cue size, which already scales with the video's rendered
    // dimensions, instead of guessing an absolute size ourselves.
    `  font-size: ${style.fontScale}em;`,
    `  font-weight: ${fontWeight};`,
    `  font-style: ${fontStyleCss};`,
    `  font-variant: ${fontVariant};`,
    `  color: ${style.foregroundColor};`,
    `  background-color: ${background};`,
    `  border-radius: ${borderRadius};`,
    `  padding: ${background === "#00000000" ? "0" : "0.15em 0.4em"};`,
    `  text-shadow: ${EDGE_SHADOW[style.edgeType](style.edgeColor)};`,
    "}",
  ].join("\n");
}

/**
 * Inserts a WebVTT STYLE block right after the "WEBVTT" header line (the
 * only place the spec allows one), replacing any leading blank lines from
 * the source file so the result is always well-formed regardless of how
 * ffmpeg formatted the original extraction.
 */
export function injectCueStyle(vttText: string, css: string): string {
  const normalized = vttText.replace(/\r\n/g, "\n");
  const headerMatch = /^WEBVTT[^\n]*\n+/.exec(normalized);
  if (!headerMatch) return vttText;
  const rest = normalized.slice(headerMatch[0].length);
  return `WEBVTT\n\nSTYLE\n${css}\n\n${rest}`;
}
