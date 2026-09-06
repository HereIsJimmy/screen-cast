<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fetchVideo, prepareVideo, relativeMediaUrl, subtitlePath, videoStreamPath } from "@/services/api";
import type { VideoDTO } from "@/types";

const route = useRoute();
const router = useRouter();

const video = ref<VideoDTO | null>(null);
const loading = ref(true);
const preparing = ref(false);
const error = ref<string | null>(null);
const ready = ref(false);
const videoEl = ref<HTMLVideoElement | null>(null);
const selectedSubtitle = ref<number | "">("");

const videoId = computed(() => String(route.params.id));

const supportedSubtitles = computed(() => video.value?.subtitles.filter((s) => !s.unsupported) ?? []);

async function load() {
  loading.value = true;
  error.value = null;
  ready.value = false;
  try {
    const v = await fetchVideo(videoId.value);
    video.value = v;
    const first = v.subtitles.find((s) => !s.unsupported);
    selectedSubtitle.value = first ? first.index : "";

    // Same reason the Cast player does this: the first request for a video
    // that needs remuxing/transcoding can take a while, so we wait for it
    // here and show "Preparando…" instead of leaving a native <video> stuck
    // spinning with no explanation.
    preparing.value = true;
    await prepareVideo(v.id);
    ready.value = true;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    preparing.value = false;
    loading.value = false;
  }
}

/** Native <video> text tracks don't support v-model — toggle .mode by hand instead. */
function applySubtitleSelection() {
  const el = videoEl.value;
  if (!el) return;
  for (const track of Array.from(el.textTracks)) {
    const trackIndex = Number(track.id);
    track.mode = selectedSubtitle.value !== "" && trackIndex === Number(selectedSubtitle.value) ? "showing" : "hidden";
  }
}

watch(selectedSubtitle, applySubtitleSelection);

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

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="loading" class="empty-state">{{ preparing ? "Preparando vídeo…" : "Cargando…" }}</div>

    <div v-else-if="video" class="player-card">
      <h2>{{ video.title }}</h2>

      <video
        v-if="ready"
        ref="videoEl"
        class="watch-video"
        :src="relativeMediaUrl(videoStreamPath(video.id))"
        controls
        autoplay
        playsinline
        @loadedmetadata="applySubtitleSelection"
      >
        <track
          v-for="sub in supportedSubtitles"
          :key="sub.index"
          :id="String(sub.index)"
          kind="subtitles"
          :src="relativeMediaUrl(subtitlePath(video.id, sub.index))"
          :srclang="sub.language || 'und'"
          :label="sub.title || sub.language || `Pista ${sub.index + 1}`"
        />
      </video>

      <div v-if="supportedSubtitles.length > 0" class="controls-row">
        <select v-model="selectedSubtitle">
          <option value="">Sin subtítulos</option>
          <option v-for="sub in supportedSubtitles" :key="sub.index" :value="sub.index">
            {{ sub.title || sub.language || `Pista ${sub.index + 1}` }}
          </option>
        </select>

        <span v-if="video.subtitles.some((s) => s.unsupported)" class="badge warn">
          Este vídeo tiene subtítulos en formato de imagen (no se pueden mostrar)
        </span>
      </div>
    </div>
  </div>
</template>
