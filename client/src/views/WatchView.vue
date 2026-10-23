<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  burnSubtitleIndexFor,
  deleteVideo,
  fetchPlaybackSettings,
  fetchVideo,
  prepareVideo,
  relativeMediaUrl,
  subtitlePath,
  videoStreamPath,
} from "@/services/api";
import type { VideoDTO } from "@/types";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { peekNext, removeFromQueue, takeNext } from "@/services/queue";
import { prepareNextInBackground } from "@/services/queueAutoplay";
import { isVideoWatched, setWatched, trackWatchProgress } from "@/services/watched";

const emit = defineEmits<{ deleted: [id: string] }>();

const route = useRoute();
const router = useRouter();

const video = ref<VideoDTO | null>(null);
const loading = ref(true);
const preparing = ref(false);
const error = ref<string | null>(null);
const ready = ref(false);
// Once created, the <video> element is kept for the popup's lifetime and
// only its src changes — including when the queue moves on to the next
// video — so fullscreen (on a phone especially) survives the switch.
const playerMounted = ref(false);
const videoEl = ref<HTMLVideoElement | null>(null);
const selectedSubtitle = ref<number | "">("");
const selectedAudioTrack = ref(0);
// Starts as PlaybackSettings.burnInByDefault, like in the Cast popup. Kept
// (not reset) when the queue moves on to the next video.
const burnIn = ref(true);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

const videoId = computed(() => String(route.params.id));

/** What the queue will play once this video ends. */
const upNext = computed(() => peekNext(videoId.value));

const supportedSubtitles = computed(() => video.value?.subtitles.filter((s) => !s.unsupported) ?? []);
const hasUnsupportedSubtitles = computed(() => video.value?.subtitles.some((s) => s.unsupported) ?? false);
const selectedSubtitleIndex = computed(() => (selectedSubtitle.value === "" ? null : Number(selectedSubtitle.value)));
const selectedIsBurnable = computed(
  () => video.value?.subtitles.some((s) => s.index === selectedSubtitleIndex.value && s.burnable) ?? false
);
const burnSubtitleIndex = computed(() =>
  video.value ? burnSubtitleIndexFor(video.value, selectedSubtitleIndex.value, burnIn.value) : null
);

/** Label for an audio-track <option>: its title (or a fallback), with the language in parentheses when known. */
function audioTrackLabel(track: { index: number; language?: string; title?: string }): string {
  const base = track.title || `Audio track ${track.index + 1}`;
  return track.language ? `${base} (${track.language})` : base;
}

// Same reason the Cast player does this: the first request for a video
// that needs remuxing/transcoding can take a while, so we wait for it here
// and show "Preparing…" instead of leaving a native <video> stuck spinning
// with no explanation. Also re-run whenever the selected audio track
// changes: there's no live audio-track switching in a plain <video>
// element, so a new choice means a fresh prepare + a new src with the new
// track baked in (the src is only set while `ready`, so the <video> reloads
// once that prepare finishes). The same goes for the burned-in subtitle
// track (burnSubtitleIndex), which is part of the picture.
async function prepareForBrowser() {
  if (!video.value) return;
  ready.value = false;
  error.value = null;
  preparing.value = true;
  try {
    await prepareVideo(video.value.id, {
      forBrowser: true,
      audioTrackIndex: selectedAudioTrack.value,
      burnSubtitleIndex: burnSubtitleIndex.value,
    });
    ready.value = true;
    playerMounted.value = true;
    prepareNextInBackground({ forBrowser: true });
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    preparing.value = false;
  }
}

// Guards the watcher below against firing (and double-preparing) when load()
// sets the audio/subtitle selection programmatically to its per-video
// defaults, as opposed to the user actually changing a dropdown — true for
// the whole span from those assignments through load()'s own
// prepareForBrowser() call.
let settingDefaults = false;

async function load() {
  // Only the first load replaces the popup with a loading message; moving
  // on to the next queued video keeps the player (and fullscreen) on screen.
  loading.value = !video.value;
  error.value = null;
  ready.value = false;
  try {
    const firstLoad = !video.value;
    const [v, settings] = await Promise.all([fetchVideo(videoId.value), fetchPlaybackSettings()]);
    if (firstLoad) burnIn.value = settings.burnInByDefault;
    video.value = v;
    removeFromQueue(v.id); // it's playing now, so it's no longer "up next"
    settingDefaults = true;
    selectedSubtitle.value = v.defaultSubtitleIndex ?? "";
    selectedAudioTrack.value = v.defaultAudioTrackIndex;
    await prepareForBrowser();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
    settingDefaults = false;
  }
}

watch([selectedAudioTrack, burnSubtitleIndex], ([audio, burn], [oldAudio, oldBurn]) => {
  if (settingDefaults || (audio === oldAudio && burn === oldBurn) || !video.value) return;
  prepareForBrowser();
});

/**
 * Native <video> text tracks don't support v-model — toggle .mode by hand
 * instead. A burned-in track is already in the picture, so it stays hidden.
 */
function applySubtitleSelection() {
  const el = videoEl.value;
  if (!el) return;
  const showing = burnSubtitleIndex.value === null ? selectedSubtitleIndex.value : null;
  for (const track of Array.from(el.textTracks)) {
    track.mode = showing !== null && Number(track.id) === showing ? "showing" : "hidden";
  }
}

watch([selectedSubtitle, burnSubtitleIndex], applySubtitleSelection);

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
    router.push({ name: "library", query: route.query });
  } catch (err) {
    deleteError.value = (err as Error).message;
  } finally {
    deleting.value = false;
  }
}

async function toggleWatched() {
  if (!video.value) return;
  try {
    await setWatched(video.value.id, !isVideoWatched(video.value));
  } catch (err) {
    error.value = (err as Error).message;
  }
}

function onTimeUpdate() {
  const el = videoEl.value;
  if (el && video.value) trackWatchProgress(video.value.id, el.currentTime, el.duration);
}

/** Autoplays the next queued video, in this same popup. */
function onEnded() {
  const next = takeNext();
  if (next) router.replace({ name: "watch", params: { id: next.id }, query: route.query });
}

onMounted(load);

watch(videoId, (id, oldId) => {
  if (route.name === "watch" && id !== oldId) load();
});
</script>

<template>
  <p v-if="error" class="error-box">{{ error }}</p>

  <div v-if="loading" class="empty-state">
    {{ !preparing ? "Loading…" : burnSubtitleIndex !== null ? "Burning in subtitles… (a minute or two the first time)" : "Preparing video…" }}
  </div>

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

    <p v-if="!loading && !ready && preparing" class="empty-state">
      {{ burnSubtitleIndex !== null ? "Burning in subtitles… (a minute or two the first time)" : "Preparing video…" }}
    </p>

    <video
      v-if="playerMounted"
      ref="videoEl"
      class="watch-video"
      :src="
        ready
          ? relativeMediaUrl(
              videoStreamPath(video.id, {
                forBrowser: true,
                audioTrackIndex: selectedAudioTrack,
                burnSubtitleIndex,
              })
            )
          : undefined
      "
      controls
      autoplay
      playsinline
      @loadedmetadata="applySubtitleSelection"
      @timeupdate="onTimeUpdate"
      @ended="onEnded"
    >
      <track
        v-for="sub in supportedSubtitles"
        :key="`${video.id}-${sub.index}`"
        :id="String(sub.index)"
        kind="subtitles"
        :src="relativeMediaUrl(subtitlePath(video.id, sub.index, { forBrowser: true }))"
        :srclang="sub.language || 'und'"
        :label="sub.title || sub.language || `Track ${sub.index + 1}`"
      />
    </video>

    <p v-if="upNext" class="up-next">⏭ Up next: {{ upNext.title }}</p>

    <div v-if="supportedSubtitles.length > 0" class="controls-row">
      <select v-model="selectedSubtitle" :disabled="preparing">
        <option value="">No subtitles</option>
        <option v-for="sub in supportedSubtitles" :key="sub.index" :value="sub.index">
          {{ sub.title || sub.language || `Track ${sub.index + 1}` }}
        </option>
      </select>

      <span v-if="hasUnsupportedSubtitles" class="badge warn">
        {{
          supportedSubtitles.length > 0
            ? "Some subtitle tracks are invalid"
            : "This video has image-based subtitles (they can't be shown)"
        }}
      </span>
    </div>

    <div v-if="selectedIsBurnable" class="controls-row">
      <label class="burn-toggle" title="Renders the subtitles into the picture, keeping their signs, drawings and fonts. Re-encodes the video (on the GPU when available), so the first play takes a minute or two.">
        <input v-model="burnIn" type="checkbox" :disabled="preparing" />
        Burn in subtitles (full styling)
      </label>
    </div>

    <div v-if="video.audioTracks.length > 1" class="controls-row">
      <select v-model.number="selectedAudioTrack" :disabled="preparing">
        <option v-for="track in video.audioTracks" :key="track.index" :value="track.index">
          {{ audioTrackLabel(track) }}
        </option>
      </select>
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
