<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  burnSubtitleIndexFor,
  deleteVideo,
  fetchPlaybackSettings,
  fetchServerInfo,
  fetchVideo,
  prepareVideo,
} from "@/services/api";
import {
  castState,
  castVideo,
  ensureCastSession,
  seekTo,
  setSubtitleTrack,
  setVolume,
  stopCasting,
  toggleMute,
  togglePlayPause,
} from "@/services/cast";
import type { ServerInfo, VideoDTO } from "@/types";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { peekNext } from "@/services/queue";
import { isVideoWatched, setWatched } from "@/services/watched";

const emit = defineEmits<{ deleted: [id: string] }>();

const route = useRoute();
const router = useRouter();

const video = ref<VideoDTO | null>(null);
const serverInfo = ref<ServerInfo | null>(null);
const loading = ref(true);
const preparing = ref(false);
const localError = ref<string | null>(null);
const selectedSubtitle = ref<number | "">("");
const selectedAudioTrack = ref(0);
// Starts as PlaybackSettings.burnInByDefault (on unless changed in
// Settings): the TV only gets plain text otherwise, which loses an ASS
// track's drawings, fonts and typesetting.
const burnIn = ref(true);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

const videoId = computed(() => String(route.params.id));

/** What the queue will cast once this video ends. */
const upNext = computed(() => peekNext(videoId.value));

// Being connected to the TV isn't the same as this page's video being what's
// loaded there — you can arrive here already connected because you were
// casting something else. Only show playback controls / the timeline when
// it's genuinely *this* video that's live on the TV right now.
const isCastingThisVideo = computed(
  () => castState.isConnected && castState.currentVideoId === video.value?.id
);

const selectedSubtitleIndex = computed(() => (selectedSubtitle.value === "" ? null : Number(selectedSubtitle.value)));
const selectedIsBurnable = computed(
  () => video.value?.subtitles.some((s) => s.index === selectedSubtitleIndex.value && s.burnable) ?? false
);
const burnSubtitleIndex = computed(() =>
  video.value ? burnSubtitleIndexFor(video.value, selectedSubtitleIndex.value, burnIn.value) : null
);
/** Subtitles baked into what's on the TV can't be switched live — that takes a new cast. */
const subtitlesLocked = computed(() => isCastingThisVideo.value && castState.burnedSubtitleIndex !== null);

const hasUnsupportedSubtitles = computed(() => video.value?.subtitles.some((s) => s.unsupported) ?? false);
const hasSupportedSubtitles = computed(() => video.value?.subtitles.some((s) => !s.unsupported) ?? false);

/** Label for an audio-track <option>: its title (or a fallback), with the language in parentheses when known. */
function audioTrackLabel(track: { index: number; language?: string; title?: string }): string {
  const base = track.title || `Audio track ${track.index + 1}`;
  return track.language ? `${base} (${track.language})` : base;
}

async function load() {
  loading.value = true;
  localError.value = null;
  try {
    const [v, info, settings] = await Promise.all([
      fetchVideo(videoId.value),
      fetchServerInfo(),
      fetchPlaybackSettings(),
    ]);
    video.value = v;
    serverInfo.value = info;
    burnIn.value = settings.burnInByDefault;
    selectedSubtitle.value = v.defaultSubtitleIndex ?? "";
    selectedAudioTrack.value = v.defaultAudioTrackIndex;
  } catch (err) {
    localError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function startCasting() {
  if (!video.value || !serverInfo.value) return;
  localError.value = null;
  try {
    // Open the TV selection dialog first, while Chrome still treats this as
    // a response to the click — preparing first can take longer than that
    // window, and then the dialog never shows up (see ensureCastSession).
    await ensureCastSession();
  } catch {
    return; // castState.error already explains what happened
  }

  preparing.value = true;
  try {
    await prepareVideo(video.value.id, {
      audioTrackIndex: selectedAudioTrack.value,
      burnSubtitleIndex: burnSubtitleIndex.value,
    });
    await castVideo(
      serverInfo.value,
      video.value,
      selectedSubtitleIndex.value,
      selectedAudioTrack.value,
      burnSubtitleIndex.value
    );
  } catch (err) {
    localError.value = (err as Error).message;
  } finally {
    preparing.value = false;
  }
}

async function toggleWatched() {
  if (!video.value) return;
  try {
    await setWatched(video.value.id, !isVideoWatched(video.value));
  } catch (err) {
    localError.value = (err as Error).message;
  }
}

function onSubtitleChange() {
  if (!video.value) return;
  if (isCastingThisVideo.value) {
    setSubtitleTrack(video.value, selectedSubtitleIndex.value);
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

async function handleDelete() {
  if (!video.value) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    if (isCastingThisVideo.value) stopCasting();
    const deletedId = video.value.id;
    await deleteVideo(deletedId);
    showDeleteConfirm.value = false;
    emit("deleted", deletedId);
    router.push({ name: "library", query: route.query });
  } catch (err) {
    deleteError.value = (err as Error).message;
  } finally {
    deleting.value = false;
  }
}

onMounted(load);

// Queue autoplay swaps the route to the next video while this popup is
// open (see queueAutoplay.ts) — reload for it instead of showing the old one.
watch(videoId, (id, oldId) => {
  if (route.name === "player" && id !== oldId) load();
});
</script>

<template>
  <p v-if="localError" class="error-box">{{ localError }}</p>
  <p v-if="castState.error" class="error-box">{{ castState.error }}</p>

  <div v-if="loading" class="empty-state">Loading…</div>

  <div v-else-if="video" class="player-card">
    <div class="modal-title-row">
      <h2>{{ video.title }}</h2>
      <button
        class="watched-toggle"
        :class="{ on: isVideoWatched(video) }"
        type="button"
        :title="isVideoWatched(video) ? 'Watched — click to mark as unwatched' : 'Mark as watched'"
        @click="toggleWatched"
      >
        {{ isVideoWatched(video) ? "✓ Watched" : "Mark as watched" }}
      </button>
    </div>

    <div class="status-line">
      <span class="dot" :class="{ connected: castState.isConnected }"></span>
      <span v-if="isCastingThisVideo">Connected to {{ castState.deviceName ?? "the TV" }}</span>
      <span v-else-if="castState.isConnected">
        Connected to {{ castState.deviceName ?? "the TV" }} (playing another video)
      </span>
      <span v-else-if="!castState.sdkReady">Initializing Google Cast…</span>
      <span v-else-if="!castState.hasCastDevices">No TVs/Chromecasts found on your network</span>
      <span v-else>Ready to cast</span>
    </div>

    <p v-if="upNext" class="up-next">⏭ Up next: {{ upNext.title }}</p>

    <div class="controls-row">
      <select v-model="selectedSubtitle" :disabled="subtitlesLocked" @change="onSubtitleChange">
        <option value="">No subtitles</option>
        <option
          v-for="sub in video.subtitles.filter((s) => !s.unsupported)"
          :key="sub.index"
          :value="sub.index"
        >
          {{ sub.title || sub.language || `Track ${sub.index + 1}` }}
        </option>
      </select>

      <span v-if="hasUnsupportedSubtitles" class="badge warn">
        {{
          hasSupportedSubtitles
            ? "Some subtitle tracks are invalid"
            : "This video has image-based subtitles (they can't be shown)"
        }}
      </span>
    </div>

    <div v-if="selectedIsBurnable" class="controls-row">
      <label class="burn-toggle" title="Renders the subtitles into the picture, keeping their signs, drawings and fonts. Re-encodes the video (on the GPU when available), so the first play takes a minute or two.">
        <input v-model="burnIn" type="checkbox" :disabled="isCastingThisVideo" />
        Burn in subtitles (full styling)
      </label>
      <span v-if="subtitlesLocked" class="hint">Burned in: stop and cast again to change subtitles.</span>
    </div>

    <div v-if="video.audioTracks.length > 1" class="controls-row">
      <select v-model.number="selectedAudioTrack" :disabled="isCastingThisVideo">
        <option v-for="track in video.audioTracks" :key="track.index" :value="track.index">
          {{ audioTrackLabel(track) }}
        </option>
      </select>
    </div>

    <div class="controls-row">
      <button
        v-if="!isCastingThisVideo"
        class="btn"
        :disabled="preparing || !castState.hasCastDevices"
        @click="startCasting"
      >
        {{ preparing ? (burnSubtitleIndex !== null ? "Burning in subtitles…" : "Preparing…") : castState.isConnected ? "▶ Play here on the TV" : "▶ Cast to TV" }}
      </button>

      <template v-else>
        <button class="btn secondary" @click="togglePlayPause">⏯ Play/Pause</button>
        <button class="btn secondary" @click="toggleMute">
          {{ castState.isMuted ? "🔇 Unmute" : "🔊 Mute" }}
        </button>
        <button class="btn secondary" @click="stopCasting">⏹ Stop</button>
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
        <span class="btn-label">Delete</span>
      </button>
    </div>
  </div>

  <ConfirmDialog
    v-if="showDeleteConfirm"
    title="Delete video"
    :message="`“${video?.title}” and all its cached files will be deleted. This can't be undone.`"
    :busy="deleting"
    :error="deleteError"
    @confirm="handleDelete"
    @close="showDeleteConfirm = false"
  />
</template>
