import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { SubtitleStyle } from "../types.js";

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontScale: 1,
  fontStyle: "NORMAL",
  fontGenericFamily: "SANS_SERIF",
  foregroundColor: "#FFFFFFFF",
  backgroundColor: "#00000000",
  edgeType: "OUTLINE",
  edgeColor: "#000000FF",
  windowType: "NONE",
  windowColor: "#00000000",
  windowRoundedCornerRadius: 8,
  subtitlePositionPercent: 90,
};

const FONT_STYLES = new Set(["NORMAL", "BOLD", "ITALIC", "BOLD_ITALIC"]);
const FONT_FAMILIES = new Set([
  "CASUAL",
  "CURSIVE",
  "MONOSPACED_SANS_SERIF",
  "MONOSPACED_SERIF",
  "SANS_SERIF",
  "SERIF",
  "SMALL_CAPITALS",
]);
const EDGE_TYPES = new Set(["NONE", "OUTLINE", "DROP_SHADOW", "RAISED", "DEPRESSED"]);
const WINDOW_TYPES = new Set(["NONE", "NORMAL", "ROUNDED_CORNERS"]);
const RGBA_HEX = /^#[0-9A-Fa-f]{8}$/;

function getStylePath(): string {
  return path.join(config.dataDir, "subtitle-style.json");
}

/**
 * Validates a candidate style object field by field, falling back to the
 * corresponding default for anything missing or malformed — so a partially
 * saved/edited file (or a partial PUT from the client) never crashes the
 * server or produces something the Cast SDK would reject.
 */
export function sanitizeSubtitleStyle(input: unknown): SubtitleStyle {
  const candidate = (input && typeof input === "object" ? input : {}) as Partial<SubtitleStyle>;
  const out: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };

  if (typeof candidate.fontScale === "number" && candidate.fontScale >= 0.5 && candidate.fontScale <= 2) {
    out.fontScale = candidate.fontScale;
  }
  if (typeof candidate.fontStyle === "string" && FONT_STYLES.has(candidate.fontStyle)) {
    out.fontStyle = candidate.fontStyle as SubtitleStyle["fontStyle"];
  }
  if (typeof candidate.fontGenericFamily === "string" && FONT_FAMILIES.has(candidate.fontGenericFamily)) {
    out.fontGenericFamily = candidate.fontGenericFamily as SubtitleStyle["fontGenericFamily"];
  }
  if (typeof candidate.edgeType === "string" && EDGE_TYPES.has(candidate.edgeType)) {
    out.edgeType = candidate.edgeType as SubtitleStyle["edgeType"];
  }
  if (typeof candidate.windowType === "string" && WINDOW_TYPES.has(candidate.windowType)) {
    out.windowType = candidate.windowType as SubtitleStyle["windowType"];
  }
  if (
    typeof candidate.windowRoundedCornerRadius === "number" &&
    candidate.windowRoundedCornerRadius >= 0 &&
    candidate.windowRoundedCornerRadius <= 32
  ) {
    out.windowRoundedCornerRadius = candidate.windowRoundedCornerRadius;
  }
  if (
    typeof candidate.subtitlePositionPercent === "number" &&
    candidate.subtitlePositionPercent >= 0 &&
    candidate.subtitlePositionPercent <= 100
  ) {
    out.subtitlePositionPercent = candidate.subtitlePositionPercent;
  }
  for (const key of ["foregroundColor", "backgroundColor", "edgeColor", "windowColor"] as const) {
    const value = candidate[key];
    if (typeof value === "string" && RGBA_HEX.test(value)) {
      out[key] = value.toUpperCase();
    }
  }

  return out;
}

export async function readSubtitleStyle(): Promise<SubtitleStyle> {
  const stylePath = getStylePath();
  if (!existsSync(stylePath)) return { ...DEFAULT_SUBTITLE_STYLE };

  try {
    const raw = await fs.readFile(stylePath, "utf-8");
    return sanitizeSubtitleStyle(JSON.parse(raw));
  } catch (err) {
    console.warn(`[subtitleStyle] No se pudo leer ${stylePath}, usando valores por defecto:`, (err as Error).message);
    return { ...DEFAULT_SUBTITLE_STYLE };
  }
}

export async function writeSubtitleStyle(input: unknown): Promise<SubtitleStyle> {
  const style = sanitizeSubtitleStyle(input);
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(getStylePath(), JSON.stringify(style, null, 2), "utf-8");
  return style;
}
