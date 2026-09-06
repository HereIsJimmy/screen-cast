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
