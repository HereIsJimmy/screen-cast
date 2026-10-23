<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
  fetchPlaybackSettings,
  fetchServerInfo,
  fetchSubtitleStyle,
  savePlaybackSettings,
  saveSubtitleStyle,
  shutdownServerPc,
} from "@/services/api";
import { applySubtitleStyleLive, castState } from "@/services/cast";
import type { PlaybackSettings, ServerInfo, SubtitleStyle } from "@/types";

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

const serverInfo = ref<ServerInfo | null>(null);
const shutdownPassword = ref("");
const shuttingDown = ref(false);
const shutdownError = ref<string | null>(null);
const shutdownDone = ref(false);

const FONT_STYLE_OPTIONS: { value: SubtitleStyle["fontStyle"]; label: string }[] = [
  { value: "NORMAL", label: "Normal" },
  { value: "BOLD", label: "Bold" },
  { value: "ITALIC", label: "Italic" },
  { value: "BOLD_ITALIC", label: "Bold italic" },
];

const FONT_FAMILY_OPTIONS: { value: SubtitleStyle["fontGenericFamily"]; label: string }[] = [
  { value: "SANS_SERIF", label: "Sans serif (recommended)" },
  { value: "SERIF", label: "Serif" },
  { value: "MONOSPACED_SANS_SERIF", label: "Monospaced sans serif" },
  { value: "MONOSPACED_SERIF", label: "Monospaced serif" },
  { value: "CASUAL", label: "Casual" },
  { value: "CURSIVE", label: "Cursive" },
  { value: "SMALL_CAPITALS", label: "Small capitals" },
];

const EDGE_TYPE_OPTIONS: { value: SubtitleStyle["edgeType"]; label: string }[] = [
  { value: "NONE", label: "None" },
  { value: "OUTLINE", label: "Outline" },
  { value: "DROP_SHADOW", label: "Drop shadow" },
  { value: "RAISED", label: "Raised" },
  { value: "DEPRESSED", label: "Depressed" },
];

const WINDOW_TYPE_OPTIONS: { value: SubtitleStyle["windowType"]; label: string }[] = [
  { value: "NONE", label: "None" },
  { value: "NORMAL", label: "Solid box" },
  { value: "ROUNDED_CORNERS", label: "Box with rounded corners" },
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

// Playback preferences save on their own, as soon as they change — unlike
// the subtitle style above, there's nothing to preview first.
const playback = ref<PlaybackSettings | null>(null);
const savingPlayback = ref(false);
const playbackSaved = ref(false);

async function onBurnInDefaultChange(event: Event) {
  if (!playback.value) return;
  const burnInByDefault = (event.target as HTMLInputElement).checked;
  savingPlayback.value = true;
  playbackSaved.value = false;
  error.value = null;
  try {
    playback.value = await savePlaybackSettings({ ...playback.value, burnInByDefault });
    playbackSaved.value = true;
    setTimeout(() => (playbackSaved.value = false), 2000);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    savingPlayback.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [current, info, playbackSettings] = await Promise.all([
      fetchSubtitleStyle(),
      fetchServerInfo(),
      fetchPlaybackSettings(),
    ]);
    Object.assign(style, current);
    serverInfo.value = info;
    playback.value = { ...playbackSettings };
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
        console.warn("[settings] Couldn't apply the style live on the TV:", err);
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

async function handleShutdown() {
  if (!shutdownPassword.value || shuttingDown.value) return;
  shuttingDown.value = true;
  shutdownError.value = null;
  try {
    await shutdownServerPc(shutdownPassword.value);
    shutdownDone.value = true;
  } catch (err) {
    shutdownError.value = (err as Error).message;
  } finally {
    shuttingDown.value = false;
    shutdownPassword.value = "";
  }
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
      <h1>⚙️ Settings</h1>
      <button class="btn secondary" @click="goBack">← Library</button>
    </header>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="loading" class="empty-state">Loading…</div>

    <div v-else class="player-card">
      <div class="settings-section">
        <h2 class="settings-section-title">Subtitle style</h2>

        <div class="subtitle-preview">
          <div class="subtitle-preview-cue" :style="{ top: style.subtitlePositionPercent + '%' }">
            <span :style="previewWindowStyle"><span :style="previewTextStyle">This is how your subtitles will look</span></span>
          </div>
        </div>

        <div class="settings-grid">
          <label class="settings-field">
            <span>Text size</span>
            <input v-model.number="style.fontScale" type="range" min="0.5" max="2" step="0.1" />
            <span class="settings-value">{{ style.fontScale.toFixed(1) }}×</span>
          </label>

          <label class="settings-field">
            <span>Vertical position</span>
            <input v-model.number="style.subtitlePositionPercent" type="range" min="0" max="100" step="1" />
            <span class="settings-value">
              {{ style.subtitlePositionPercent }}%
              ({{ style.subtitlePositionPercent < 34 ? "top" : style.subtitlePositionPercent > 66 ? "bottom" : "middle" }})
            </span>
          </label>

          <label class="settings-field">
            <span>Font style</span>
            <select v-model="style.fontStyle">
              <option v-for="opt in FONT_STYLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>

          <label class="settings-field">
            <span>Typeface</span>
            <select v-model="style.fontGenericFamily">
              <option v-for="opt in FONT_FAMILY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>

          <div class="settings-field">
            <span>Text color</span>
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
            <span>Background behind text</span>
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
            <span>Text edge</span>
            <select v-model="style.edgeType">
              <option v-for="opt in EDGE_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>

          <div class="settings-field" v-if="style.edgeType !== 'NONE'">
            <span>Edge color</span>
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
            <span>Subtitle box</span>
            <select v-model="style.windowType">
              <option v-for="opt in WINDOW_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>

          <div class="settings-field" v-if="style.windowType !== 'NONE'">
            <span>Box color</span>
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
            <span>Corner rounding</span>
            <input v-model.number="style.windowRoundedCornerRadius" type="range" min="0" max="32" step="1" />
            <span class="settings-value">{{ style.windowRoundedCornerRadius }}px</span>
          </label>
        </div>

        <div class="controls-row">
          <button class="btn" :disabled="saving" @click="save">
            {{ saving ? "Saving…" : "Save" }}
          </button>
          <button class="btn secondary" :disabled="saving" @click="resetToDefaults">Reset to defaults</button>
          <span v-if="justSaved" class="badge" style="background: #1f3a24; color: #7fd18a">Saved ✓</span>
        </div>

        <p class="settings-hint">
          Applies to the subtitles of every video. If you're casting something right now, the change is sent to the
          TV as soon as you save; otherwise it applies the next time you click "Cast". Vertical position is the
          exception: since it's baked into the subtitle file itself, it doesn't update live — it applies the next
          time you switch subtitle tracks or cast again.
        </p>
      </div>

      <div v-if="playback" class="settings-section">
        <h2 class="settings-section-title">Playback</h2>

        <div class="controls-row">
          <label class="burn-toggle">
            <input
              type="checkbox"
              :checked="playback.burnInByDefault"
              :disabled="savingPlayback"
              @change="onBurnInDefaultChange"
            />
            Burn in ASS subtitles by default
          </label>
          <span v-if="playbackSaved" class="badge" style="background: #1f3a24; color: #7fd18a">Saved ✓</span>
        </div>

        <p class="settings-hint">
          Whether "Burn in subtitles (full styling)" starts ticked in the Cast and Play popups when the subtitle track
          is ASS/SSA. You can still change it per video there. The library's prepare buttons and the queue also follow
          this setting.
        </p>
      </div>

      <div v-if="serverInfo?.shutdownEnabled" class="settings-section">
        <h2 class="settings-section-title">Miscellaneous</h2>

        <p v-if="shutdownDone" class="settings-hint">
          The server PC is shutting down… this page will stop responding in a few seconds.
        </p>

        <template v-else>
          <div class="settings-grid">
            <label class="settings-field">
              <span>Shutdown</span>
              <input
                v-model="shutdownPassword"
                type="password"
                autocomplete="off"
                placeholder="Shutdown password"
                @keyup.enter="handleShutdown"
              />
            </label>
          </div>

          <div class="controls-row">
            <button
              class="btn danger"
              type="button"
              :disabled="shuttingDown || !shutdownPassword"
              @click="handleShutdown"
            >
              {{ shuttingDown ? "Shutting down…" : "Shut down the server PC" }}
            </button>
          </div>

          <p v-if="shutdownError" class="error-box">{{ shutdownError }}</p>
        </template>
      </div>
    </div>
  </div>
</template>
