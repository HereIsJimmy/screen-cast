<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { fetchSubtitleStyle, saveSubtitleStyle } from "@/services/api";
import { applySubtitleStyleLive, castState } from "@/services/cast";
import type { SubtitleStyle } from "@/types";

const router = useRouter();

const DEFAULT_STYLE: SubtitleStyle = {
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

const style = reactive<SubtitleStyle>({ ...DEFAULT_STYLE });
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const justSaved = ref(false);

const FONT_STYLE_OPTIONS: { value: SubtitleStyle["fontStyle"]; label: string }[] = [
  { value: "NORMAL", label: "Normal" },
  { value: "BOLD", label: "Negrita" },
  { value: "ITALIC", label: "Cursiva" },
  { value: "BOLD_ITALIC", label: "Negrita cursiva" },
];

const FONT_FAMILY_OPTIONS: { value: SubtitleStyle["fontGenericFamily"]; label: string }[] = [
  { value: "SANS_SERIF", label: "Sin serifa (recomendado)" },
  { value: "SERIF", label: "Con serifa" },
  { value: "MONOSPACED_SANS_SERIF", label: "Monoespaciada sin serifa" },
  { value: "MONOSPACED_SERIF", label: "Monoespaciada con serifa" },
  { value: "CASUAL", label: "Informal" },
  { value: "CURSIVE", label: "Manuscrita" },
  { value: "SMALL_CAPITALS", label: "Versalitas" },
];

const EDGE_TYPE_OPTIONS: { value: SubtitleStyle["edgeType"]; label: string }[] = [
  { value: "NONE", label: "Ninguno" },
  { value: "OUTLINE", label: "Contorno" },
  { value: "DROP_SHADOW", label: "Sombra" },
  { value: "RAISED", label: "Relieve" },
  { value: "DEPRESSED", label: "Grabado" },
];

const WINDOW_TYPE_OPTIONS: { value: SubtitleStyle["windowType"]; label: string }[] = [
  { value: "NONE", label: "Ninguno" },
  { value: "NORMAL", label: "Caja sólida" },
  { value: "ROUNDED_CORNERS", label: "Caja con esquinas redondeadas" },
];

type ColorField = "foregroundColor" | "backgroundColor" | "edgeColor" | "windowColor";

function hexOf(rgba: string): string {
  return rgba.slice(0, 7);
}
function alphaOf(rgba: string): number {
  const hex = rgba.slice(7, 9);
  return hex ? parseInt(hex, 16) / 255 : 1;
}
function joinRgba(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`.toUpperCase();
}
function setHex(field: ColorField, event: Event) {
  const hex = (event.target as HTMLInputElement).value;
  style[field] = joinRgba(hex, alphaOf(style[field]));
}
function setAlpha(field: ColorField, event: Event) {
  const alpha = Number((event.target as HTMLInputElement).value);
  style[field] = joinRgba(hexOf(style[field]), alpha);
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const current = await fetchSubtitleStyle();
    Object.assign(style, current);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = null;
  justSaved.value = false;
  try {
    const saved = await saveSubtitleStyle({ ...style });
    Object.assign(style, saved);
    justSaved.value = true;
    setTimeout(() => (justSaved.value = false), 2000);
    if (castState.isConnected) {
      await applySubtitleStyleLive(saved).catch((err) => {
        // Not fatal — it'll still apply the next time something is cast —
        // but log it so it's obvious in DevTools why a live change didn't show up.
        console.warn("[settings] No se pudo aplicar el estilo en directo a la TV:", err);
      });
    }
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

function resetToDefaults() {
  Object.assign(style, DEFAULT_STYLE);
}

function goBack() {
  router.push({ name: "library" });
}

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

const previewWindowStyle = computed(() => ({
  background: style.windowType === "NONE" ? "transparent" : style.windowColor,
  borderRadius: style.windowType === "ROUNDED_CORNERS" ? `${style.windowRoundedCornerRadius}px` : "0px",
  padding: style.windowType === "NONE" ? "0" : "10px 16px",
  display: "inline-block",
}));

const previewTextStyle = computed(() => ({
  background: style.backgroundColor,
  color: style.foregroundColor,
  fontFamily: FONT_FAMILY_CSS[style.fontGenericFamily],
  fontVariant: style.fontGenericFamily === "SMALL_CAPITALS" ? "small-caps" : "normal",
  fontWeight: style.fontStyle === "BOLD" || style.fontStyle === "BOLD_ITALIC" ? "bold" : "normal",
  fontStyle: style.fontStyle === "ITALIC" || style.fontStyle === "BOLD_ITALIC" ? "italic" : "normal",
  fontSize: `${1.4 * style.fontScale}rem`,
  textShadow: EDGE_SHADOW[style.edgeType](style.edgeColor),
  padding: "2px 6px",
  lineHeight: 1.4,
}));

onMounted(load);
</script>

<template>
  <div class="container">
    <header class="app-header">
      <h1>🎨 Estilo de subtítulos</h1>
      <button class="btn secondary" @click="goBack">← Biblioteca</button>
    </header>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="loading" class="empty-state">Cargando…</div>

    <div v-else class="player-card">
      <div class="subtitle-preview">
        <div class="subtitle-preview-cue" :style="{ top: style.subtitlePositionPercent + '%' }">
          <span :style="previewWindowStyle"><span :style="previewTextStyle">Así se verán tus subtítulos</span></span>
        </div>
      </div>

      <div class="settings-grid">
        <label class="settings-field">
          <span>Tamaño del texto</span>
          <input v-model.number="style.fontScale" type="range" min="0.5" max="2" step="0.1" />
          <span class="settings-value">{{ style.fontScale.toFixed(1) }}×</span>
        </label>

        <label class="settings-field">
          <span>Posición vertical</span>
          <input v-model.number="style.subtitlePositionPercent" type="range" min="0" max="100" step="1" />
          <span class="settings-value">
            {{ style.subtitlePositionPercent }}%
            ({{ style.subtitlePositionPercent < 34 ? "arriba" : style.subtitlePositionPercent > 66 ? "abajo" : "centro" }})
          </span>
        </label>

        <label class="settings-field">
          <span>Estilo de fuente</span>
          <select v-model="style.fontStyle">
            <option v-for="opt in FONT_STYLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>

        <label class="settings-field">
          <span>Tipo de letra</span>
          <select v-model="style.fontGenericFamily">
            <option v-for="opt in FONT_FAMILY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>

        <div class="settings-field">
          <span>Color del texto</span>
          <div class="color-row">
            <input type="color" :value="hexOf(style.foregroundColor)" @input="setHex('foregroundColor', $event)" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="alphaOf(style.foregroundColor)"
              @input="setAlpha('foregroundColor', $event)"
            />
            <span class="settings-value">{{ Math.round(alphaOf(style.foregroundColor) * 100) }}%</span>
          </div>
        </div>

        <div class="settings-field">
          <span>Fondo tras el texto</span>
          <div class="color-row">
            <input type="color" :value="hexOf(style.backgroundColor)" @input="setHex('backgroundColor', $event)" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="alphaOf(style.backgroundColor)"
              @input="setAlpha('backgroundColor', $event)"
            />
            <span class="settings-value">{{ Math.round(alphaOf(style.backgroundColor) * 100) }}%</span>
          </div>
        </div>

        <label class="settings-field">
          <span>Borde del texto</span>
          <select v-model="style.edgeType">
            <option v-for="opt in EDGE_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>

        <div class="settings-field" v-if="style.edgeType !== 'NONE'">
          <span>Color del borde</span>
          <div class="color-row">
            <input type="color" :value="hexOf(style.edgeColor)" @input="setHex('edgeColor', $event)" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="alphaOf(style.edgeColor)"
              @input="setAlpha('edgeColor', $event)"
            />
            <span class="settings-value">{{ Math.round(alphaOf(style.edgeColor) * 100) }}%</span>
          </div>
        </div>

        <label class="settings-field">
          <span>Caja de subtítulos</span>
          <select v-model="style.windowType">
            <option v-for="opt in WINDOW_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>

        <div class="settings-field" v-if="style.windowType !== 'NONE'">
          <span>Color de la caja</span>
          <div class="color-row">
            <input type="color" :value="hexOf(style.windowColor)" @input="setHex('windowColor', $event)" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="alphaOf(style.windowColor)"
              @input="setAlpha('windowColor', $event)"
            />
            <span class="settings-value">{{ Math.round(alphaOf(style.windowColor) * 100) }}%</span>
          </div>
        </div>

        <label class="settings-field" v-if="style.windowType === 'ROUNDED_CORNERS'">
          <span>Redondeo de esquinas</span>
          <input v-model.number="style.windowRoundedCornerRadius" type="range" min="0" max="32" step="1" />
          <span class="settings-value">{{ style.windowRoundedCornerRadius }}px</span>
        </label>
      </div>

      <div class="controls-row">
        <button class="btn" :disabled="saving" @click="save">
          {{ saving ? "Guardando…" : "Guardar" }}
        </button>
        <button class="btn secondary" :disabled="saving" @click="resetToDefaults">Restablecer valores</button>
        <span v-if="justSaved" class="badge" style="background: #1f3a24; color: #7fd18a">Guardado ✓</span>
      </div>

      <p class="settings-hint">
        Se aplica a los subtítulos de todos los vídeos. Si ahora mismo estás casteando algo, el cambio se envía a la
        TV en cuanto guardas; si no, se aplicará la próxima vez que le des a "Castear". La posición vertical es la
        excepción: al ir incrustada en el propio archivo de subtítulos, no se actualiza en caliente — se aplicará la
        próxima vez que cambies de pista de subtítulos o vuelvas a castear.
      </p>
    </div>
  </div>
</template>
