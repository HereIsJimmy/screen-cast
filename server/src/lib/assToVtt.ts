/**
 * ASS/SSA → WebVTT conversion. ffmpeg's own webvtt encoder is too literal
 * for ASS: it keeps vector drawings (`{\p1}m 0 0 l 150 0 ...`) as visible
 * text, leaves the `\h` hard-space escape in, and throws away every
 * position/alignment, so signs, songs and top-of-screen lines all end up
 * stacked on the dialogue line. Here the track is extracted untouched
 * (`-c:s copy -f ass`) and converted by hand instead:
 *
 * - drawings are dropped, `\h` becomes a no-break space, `\N` a line break;
 * - `\i` `\b` `\u` (and the style's own italic/bold/underline) become
 *   `<i>` `<b>` `<u>`; every other override tag is stripped;
 * - alignment (style or `\an`/`\a`) and `\pos`/`\move` become WebVTT
 *   `line`/`position`/`align` cue settings. Plain bottom-centered cues (the
 *   dialogue) get no `line`, so applyCuePosition in subtitleVtt.ts still
 *   places them at the user's chosen height;
 * - typesetting duplicates (the same text stacked in several layers for a
 *   glow/border, or split into frame-by-frame events for motion tracking)
 *   collapse into a single cue.
 */

interface AssStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Numpad-style alignment (1–9), already converted from legacy SSA numbering. */
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

interface Cue {
  start: number;
  end: number;
  settings: string;
  text: string;
}

const DEFAULT_STYLE: AssStyle = {
  bold: false,
  italic: false,
  underline: false,
  alignment: 2,
  marginL: 0,
  marginR: 0,
  marginV: 0,
};

/** SSA v4 (and the `\a` tag) number alignments 1–3 bottom, 5–7 top, 9–11 middle. */
function legacyToNumpad(a: number): number {
  const col = ((a - 1) % 4) + 1; // 1 left, 2 center, 3 right
  if (a >= 9) return col + 3;
  if (a >= 5) return col + 6;
  return col;
}

function parseTime(value: string): number | null {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(value);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

function formatTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ASS booleans are -1/1 for true, 0 for false; `\b` also accepts weights like 700. */
function assTrue(value: string | undefined): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0;
}

function pct(value: number, total: number): string {
  const p = Math.min(100, Math.max(0, (value / total) * 100));
  return `${Math.round(p * 10) / 10}%`;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

interface ParsedText {
  runs: Run[];
  /** Numpad alignment override from `\an`/`\a`, if any. */
  alignment: number | null;
  /** `\pos`, or the start point of `\move`, in script coordinates. */
  pos: { x: number; y: number } | null;
}

function parseDialogueText(
  raw: string,
  baseStyle: AssStyle,
  styles: Map<string, AssStyle>,
  wrapStyle: number
): ParsedText {
  const runs: Run[] = [];
  let alignment: number | null = null;
  let pos: { x: number; y: number } | null = null;
  let style = baseStyle;
  let bold = style.bold;
  let italic = style.italic;
  let underline = style.underline;
  let drawing = false;

  const pushText = (text: string) => {
    if (drawing || !text) return;
    const decoded = text
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, wrapStyle === 2 ? "\n" : " ")
      .replace(/\\h/g, " ");
    runs.push({ text: decoded, bold, italic, underline });
  };

  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf("{", i);
    const close = open === -1 ? -1 : raw.indexOf("}", open);
    if (open === -1 || close === -1) {
      pushText(raw.slice(i));
      break;
    }
    pushText(raw.slice(i, open));
    // Tags are "\name[args]"; anything in braces that isn't a tag is a
    // comment, which the split below naturally ignores.
    for (const tag of raw.slice(open + 1, close).split("\\").slice(1)) {
      let m: RegExpExecArray | null;
      if ((m = /^an([1-9])/.exec(tag))) {
        alignment ??= Number(m[1]);
      } else if ((m = /^a(\d+)/.exec(tag))) {
        alignment ??= legacyToNumpad(Number(m[1]));
      } else if ((m = /^(?:pos|move)\(\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(tag))) {
        pos ??= { x: Number(m[1]), y: Number(m[2]) };
      } else if ((m = /^p(\d+)/.exec(tag))) {
        drawing = Number(m[1]) > 0;
      } else if ((m = /^i(\d*)\s*$/.exec(tag))) {
        italic = m[1] === "" ? style.italic : assTrue(m[1]);
      } else if ((m = /^b(\d*)\s*$/.exec(tag))) {
        bold = m[1] === "" ? style.bold : assTrue(m[1]);
      } else if ((m = /^u(\d*)\s*$/.exec(tag))) {
        underline = m[1] === "" ? style.underline : assTrue(m[1]);
      } else if ((m = /^r(.*)$/.exec(tag))) {
        style = styles.get((m[1] ?? "").trim()) ?? baseStyle;
        ({ bold, italic, underline } = style);
      }
    }
    i = close + 1;
  }

  return { runs, alignment, pos };
}

/** Turns runs into WebVTT cue text, one self-contained (tag-balanced) line per `\N`. */
function runsToCueText(runs: Run[]): string {
  const lines: Run[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...run, text: part });
    });
  }

  return lines
    .map((line) => {
      if (line.every((r) => !r.text.trim())) return "";
      return line
        .map((r, idx) => {
          let text = r.text;
          // Trim ordinary spaces at the line's edges, but keep \h (U+00A0):
          // scripts use it on purpose for indentation.
          if (idx === 0) text = text.replace(/^[ \t]+/, "");
          if (idx === line.length - 1) text = text.replace(/[ \t]+$/, "");
          let out = escapeHtml(text);
          if (r.underline) out = `<u>${out}</u>`;
          if (r.bold) out = `<b>${out}</b>`;
          if (r.italic) out = `<i>${out}</i>`;
          return out;
        })
        .join("")
        .replace(/<\/i><i>|<\/b><b>|<\/u><u>/g, "");
    })
    .filter((line) => line !== "")
    .join("\n");
}

function cueSettings(
  alignment: number,
  pos: { x: number; y: number } | null,
  margins: { l: number; r: number; v: number },
  playResX: number,
  playResY: number
): string {
  const col = ((alignment - 1) % 3) + 1; // 1 left, 2 center, 3 right
  const row = alignment >= 7 ? "top" : alignment >= 4 ? "middle" : "bottom";
  const settings: string[] = [];

  if (pos) {
    const lineAlign = row === "top" ? "start" : row === "middle" ? "center" : "end";
    settings.push(`line:${pct(pos.y, playResY)},${lineAlign}`);
    const posAlign = col === 1 ? "line-left" : col === 3 ? "line-right" : "center";
    settings.push(`position:${pct(pos.x, playResX)},${posAlign}`);
  } else {
    if (row === "top") settings.push(`line:${pct(margins.v, playResY)},start`);
    else if (row === "middle") settings.push("line:50%,center");
    // Bottom row: no line on purpose — applyCuePosition fills in the user's setting.
    if (col === 1) settings.push(`position:${pct(margins.l, playResX)},line-left`);
    else if (col === 3) settings.push(`position:${pct(playResX - margins.r, playResX)},line-right`);
  }
  if (col === 1) settings.push("align:left");
  else if (col === 3) settings.push("align:right");
  return settings.join(" ");
}

function splitFields(line: string, count: number): string[] {
  const parts = line.split(",");
  if (parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(",")];
}

export function assToVtt(assText: string): string {
  const info = new Map<string, string>();
  const styles = new Map<string, AssStyle>();
  const dialogues: { fields: Record<string, string> }[] = [];
  let section = "";
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];

  for (const rawLine of assText.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      section = (sectionMatch[1] ?? "").toLowerCase();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (section === "script info") {
      info.set(key.toLowerCase(), value);
    } else if (section === "v4+ styles" || section === "v4 styles") {
      if (key === "Format") styleFormat = value.split(",").map((f) => f.trim().toLowerCase());
      else if (key === "Style") {
        const parts = splitFields(value, styleFormat.length).map((p) => p.trim());
        const field = (name: string) => parts[styleFormat.indexOf(name)];
        const rawAlign = Number(field("alignment"));
        const isLegacy = section === "v4 styles";
        styles.set(field("name") ?? "", {
          bold: assTrue(field("bold")),
          italic: assTrue(field("italic")),
          underline: assTrue(field("underline")),
          alignment: Number.isFinite(rawAlign) && rawAlign > 0 ? (isLegacy ? legacyToNumpad(rawAlign) : rawAlign) : 2,
          marginL: Number(field("marginl")) || 0,
          marginR: Number(field("marginr")) || 0,
          marginV: Number(field("marginv")) || 0,
        });
      }
    } else if (section === "events") {
      if (key === "Format") eventFormat = value.split(",").map((f) => f.trim().toLowerCase());
      else if (key === "Dialogue" && eventFormat.length) {
        const parts = splitFields(value, eventFormat.length);
        const fields: Record<string, string> = {};
        eventFormat.forEach((name, idx) => (fields[name] = parts[idx] ?? ""));
        dialogues.push({ fields });
      }
    }
  }

  // Same defaults libass uses when the script leaves PlayRes out.
  let playResX = Number(info.get("playresx")) || 0;
  let playResY = Number(info.get("playresy")) || 0;
  if (!playResX && !playResY) [playResX, playResY] = [384, 288];
  else if (!playResY) playResY = playResX === 1280 ? 1024 : (playResX * 3) / 4;
  else if (!playResX) playResX = playResY === 1024 ? 1280 : (playResY * 4) / 3;
  const wrapStyle = Number(info.get("wrapstyle")) || 0;

  const cues: Cue[] = [];
  for (const { fields } of dialogues) {
    const start = parseTime(fields.start ?? "");
    const end = parseTime(fields.end ?? "");
    if (start === null || end === null || end <= start) continue;

    const style = styles.get((fields.style ?? "").trim().replace(/^\*/, "")) ?? styles.get("Default") ?? DEFAULT_STYLE;
    const parsed = parseDialogueText(fields.text ?? "", style, styles, wrapStyle);
    const text = runsToCueText(parsed.runs);
    if (!text) continue;

    const margins = {
      l: Number(fields.marginl) || style.marginL,
      r: Number(fields.marginr) || style.marginR,
      v: Number(fields.marginv) || style.marginV,
    };
    const settings = cueSettings(parsed.alignment ?? style.alignment, parsed.pos, margins, playResX, playResY);
    cues.push({ start, end, settings, text });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  // Collapse typesetting duplicates: the same text in the same place that
  // overlaps (or directly follows, within ~a frame) an earlier cue just
  // extends that cue instead of rendering a second copy.
  const merged: Cue[] = [];
  const lastByKey = new Map<string, Cue>();
  for (const cue of cues) {
    const key = `${cue.settings}\u0000${cue.text}`;
    const prev = lastByKey.get(key);
    if (prev && cue.start <= prev.end + 0.05) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    const copy = { ...cue };
    merged.push(copy);
    lastByKey.set(key, copy);
  }

  const body = merged
    .map((c) => `${formatTime(c.start)} --> ${formatTime(c.end)}${c.settings ? ` ${c.settings}` : ""}\n${c.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
