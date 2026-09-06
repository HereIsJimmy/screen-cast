<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deleteVideo, fetchVideo, prepareVideo, relativeMediaUrl, subtitlePath, videoStreamPath } from "@/services/api";
import type { VideoDTO } from "@/types";
import ConfirmDialog from "@/components/ConfirmDialog.vue";

const emit = defineEmits<{ deleted: [id: string] }>();

const route = useRoute();
const router = useRouter();

const video = ref<VideoDTO | null>(null);
const loading = ref(true);
const preparing = ref(false);
const error = ref<string | null>(null);
const ready = ref(false);
const videoEl = ref<HTMLVideoElement | null>(null);
const selectedSubtitle = ref<number | "">("");
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

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
    await prepareVideo(v.id, { forBrowser: true });
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

async function handleDelete() {
  if (!video.value) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    videoEl.value?.pause();
    const deletedId = video.value.id;
    await deleteVideo(deletedId);
    showDeleteConfirm.value = false;
    emit("deleted", deletedId);
    router.push({ name: "library" });
  } catch (err) {
    deleteError.value = (err as Error).message;
  } finally {
    deleting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <p v-if="error" class="error-box">{{ error }}</p>

  <div v-if="loading" class="empty-state">{{ preparing ? "Preparando vídeo…" : "Cargando…" }}</div>

  <div v-else-if="video" class="player-card">
    <div class="modal-title-row">
      <h2>{{ video.title }}</h2>
    </div>

    <video
      v-if="ready"
      ref="videoEl"
      class="watch-video"
      :src="relativeMediaUrl(videoStreamPath(video.id, { forBrowser: true }))"
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
        :src="relativeMediaUrl(subtitlePath(video.id, sub.index, { forBrowser: true }))"
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

    <div class="modal-actions">
      <button class="btn danger modal-delete-btn" type="button" @click="showDeleteConfirm = true">
        <svg
          class="icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        <span class="btn-label">Eliminar</span>
      </button>
    </div>
  </div>

  <ConfirmDialog
    v-if="showDeleteConfirm"
    title="Eliminar vídeo"
    :message="`Se eliminará «${video?.title}» y todos sus archivos en caché. Esta acción no se puede deshacer.`"
    :busy="deleting"
    :error="deleteError"
    @confirm="handleDelete"
    @close="showDeleteConfirm = false"
  />
</template>
