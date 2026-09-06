<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fetchServerInfo, fetchVideo, prepareVideo } from "@/services/api";
import {
  castState,
  castVideo,
  seekTo,
  setSubtitleTrack,
  setVolume,
  stopCasting,
  toggleMute,
  togglePlayPause,
} from "@/services/cast";
import type { ServerInfo, VideoDTO } from "@/types";

const route = useRoute();
const router = useRouter();

const video = ref<VideoDTO | null>(null);
const serverInfo = ref<ServerInfo | null>(null);
const loading = ref(true);
const preparing = ref(false);
const localError = ref<string | null>(null);
const selectedSubtitle = ref<number | "">("");

const videoId = computed(() => String(route.params.id));

// Being connected to the TV isn't the same as this page's video being what's
// loaded there — you can arrive here already connected because you were
// casting something else. Only show playback controls / the timeline when
// it's genuinely *this* video that's live on the TV right now.
const isCastingThisVideo = computed(
  () => castState.isConnected && castState.currentVideoId === video.value?.id
);

async function load() {
  loading.value = true;
  localError.value = null;
  try {
    const [v, info] = await Promise.all([fetchVideo(videoId.value), fetchServerInfo()]);
    video.value = v;
    serverInfo.value = info;
    if (v.subtitles.length > 0) {
      const first = v.subtitles.find((s) => !s.unsupported);
      selectedSubtitle.value = first ? first.index : "";
    }
  } catch (err) {
    localError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function startCasting() {
  if (!video.value || !serverInfo.value) return;
  localError.value = null;
  preparing.value = true;
  try {
    await prepareVideo(video.value.id);
    const subIndex = selectedSubtitle.value === "" ? null : Number(selectedSubtitle.value);
    await castVideo(serverInfo.value, video.value, subIndex);
  } catch (err) {
    localError.value = (err as Error).message;
  } finally {
    preparing.value = false;
  }
}

function onSubtitleChange() {
  if (!video.value) return;
  const subIndex = selectedSubtitle.value === "" ? null : Number(selectedSubtitle.value);
  if (isCastingThisVideo.value) {
    setSubtitleTrack(video.value, subIndex);
  }
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function onSeekChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  seekTo(value);
}

function onVolumeChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  setVolume(value);
}

function goBack() {
  router.push({ name: "library" });
}

onMounted(load);
</script>

<template>
  <div class="container">
    <header class="app-header">
      <button class="btn secondary" @click="goBack">← Biblioteca</button>
    </header>

    <p v-if="localError" class="error-box">{{ localError }}</p>
    <p v-if="castState.error" class="error-box">{{ castState.error }}</p>

    <div v-if="loading" class="empty-state">Cargando…</div>

    <div v-else-if="video" class="player-card">
      <h2>{{ video.title }}</h2>

      <div class="status-line">
        <span class="dot" :class="{ connected: castState.isConnected }"></span>
        <span v-if="isCastingThisVideo">Conectado a {{ castState.deviceName ?? "la TV" }}</span>
        <span v-else-if="castState.isConnected">
          Conectado a {{ castState.deviceName ?? "la TV" }} (reproduciendo otro vídeo)
        </span>
        <span v-else-if="!castState.sdkReady">Inicializando Google Cast…</span>
        <span v-else-if="!castState.hasCastDevices">No se han encontrado TVs/Chromecasts en tu red</span>
        <span v-else>Listo para castear</span>
      </div>

      <div class="controls-row">
        <select v-model="selectedSubtitle" @change="onSubtitleChange">
          <option value="">Sin subtítulos</option>
          <option
            v-for="sub in video.subtitles.filter((s) => !s.unsupported)"
            :key="sub.index"
            :value="sub.index"
          >
            {{ sub.title || sub.language || `Pista ${sub.index + 1}` }}
          </option>
        </select>

        <span v-if="video.subtitles.some((s) => s.unsupported)" class="badge warn">
          Este vídeo tiene subtítulos en formato de imagen (no se pueden mostrar)
        </span>
      </div>

      <div class="controls-row">
        <button
          v-if="!isCastingThisVideo"
          class="btn"
          :disabled="preparing || !castState.hasCastDevices"
          @click="startCasting"
        >
          {{ preparing ? "Preparando…" : castState.isConnected ? "▶ Reproducir aquí en la TV" : "▶ Castear a la TV" }}
        </button>

        <template v-else>
          <button class="btn secondary" @click="togglePlayPause">⏯ Reproducir/Pausa</button>
          <button class="btn secondary" @click="toggleMute">
            {{ castState.isMuted ? "🔇 Quitar silencio" : "🔊 Silenciar" }}
          </button>
          <button class="btn secondary" @click="stopCasting">⏹ Detener</button>
        </template>
      </div>

      <template v-if="isCastingThisVideo">
        <input
          class="timeline"
          type="range"
          min="0"
          :max="castState.durationSec || 0"
          :value="castState.currentTimeSec"
          @change="onSeekChange"
        />
        <div class="time-labels">
          <span>{{ formatTime(castState.currentTimeSec) }}</span>
          <span>{{ formatTime(castState.durationSec) }}</span>
        </div>

        <div class="controls-row">
          <label for="volume">🔉</label>
          <input id="volume" type="range" min="0" max="1" step="0.05" @change="onVolumeChange" />
        </div>
      </template>
    </div>
  </div>
</template>
