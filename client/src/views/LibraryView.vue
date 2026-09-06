<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deleteVideo, fetchLibrary, fetchServerInfo, rescanLibrary, thumbnailUrl } from "@/services/api";
import type { VideoDTO } from "@/types";
import Modal from "@/components/Modal.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import PlayerView from "@/views/PlayerView.vue";
import WatchView from "@/views/WatchView.vue";

const route = useRoute();
const router = useRouter();
const videos = ref<VideoDTO[]>([]);
const loading = ref(true);
const rescanning = ref(false);
const error = ref<string | null>(null);
const includesOld = ref(false);
const recentMonths = ref(3);
const searchQuery = ref("");
// Videos without a usable thumbnail (no video stream, ffmpeg couldn't grab a
// frame, etc.) — tracked so we swap in a placeholder instead of a broken
// <img> icon, without retrying the request in a loop.
const thumbnailFailed = reactive(new Set<string>());

// Infinite scroll is purely client-side: the server always returns the full
// (already filtered-by-recency) list, we just reveal it 100 at a time so a
// huge library doesn't render thousands of cards/thumbnails at once.
const PAGE_SIZE = 100;
const visibleCount = ref(PAGE_SIZE);
const scrollSentinel = ref<HTMLElement | null>(null);
let sentinelObserver: IntersectionObserver | null = null;

// The "player"/"watch" routes are shown as a popup layered on top of this
// same library view, instead of navigating to a separate page — that way
// the URL still changes (deep-linkable, shareable, back-button friendly),
// but a direct visit to /play/:id or /ver/:id shows the library first and
// only opens the popup once its own initial load has finished.
const activeModal = computed<"player" | "watch" | null>(() => {
  if (loading.value) return null;
  if (route.name === "player") return "player";
  if (route.name === "watch") return "watch";
  return null;
});

function closeModal() {
  router.push({ name: "library" });
}

const filteredVideos = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return videos.value;
  return videos.value.filter((video) => video.title.toLowerCase().includes(q));
});

const visibleVideos = computed(() => filteredVideos.value.slice(0, visibleCount.value));
const hasMoreVideos = computed(() => visibleCount.value < filteredVideos.value.length);

function loadMoreVideos() {
  visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, filteredVideos.value.length);
}

// A new search (or a fresh scan result) should always start back at the top
// page rather than keeping whatever count scrolling had reached before.
watch([searchQuery, videos], () => {
  visibleCount.value = PAGE_SIZE;
});

// The sentinel <div> only exists in the DOM once the grid is actually
// rendered (it's inside a v-else branch), so watch the template ref itself
// and (re)attach the observer whenever it appears/disappears.
watch(scrollSentinel, (el, previousEl) => {
  if (previousEl && sentinelObserver) sentinelObserver.unobserve(previousEl);
  if (el && sentinelObserver) sentinelObserver.observe(el);
});

function onThumbnailError(videoId: string) {
  thumbnailFailed.add(videoId);
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await fetchLibrary();
    videos.value = data.videos;
    includesOld.value = data.includesOld;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function rescan(includeOld: boolean) {
  rescanning.value = true;
  error.value = null;
  try {
    await rescanLibrary(includeOld);
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    rescanning.value = false;
  }
}

// The "show old videos too" toggle isn't just a display filter: turning it
// on tells the server to actually probe (ffprobe) the older files it had
// skipped, and turning it back off makes it drop them from the index again
// so the next scan stays fast. So flipping it always re-triggers a scan.
function onToggleIncludeOld(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  rescan(checked);
}

function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

// Deleting a video can be triggered from the trash icon on a thumbnail
// (right here) or from inside the Castear/Reproducir popup (PlayerView /
// WatchView emit "deleted" once they've done it) — either way the video
// just needs to disappear from this list, without a full re-fetch.
const videoPendingDelete = ref<VideoDTO | null>(null);
const deletingFromGrid = ref(false);
const deleteGridError = ref<string | null>(null);

function requestDelete(video: VideoDTO) {
  deleteGridError.value = null;
  videoPendingDelete.value = video;
}

function cancelDelete() {
  videoPendingDelete.value = null;
}

function removeVideoFromList(id: string) {
  videos.value = videos.value.filter((v) => v.id !== id);
}

async function confirmDeleteFromGrid() {
  const target = videoPendingDelete.value;
  if (!target) return;
  deletingFromGrid.value = true;
  deleteGridError.value = null;
  try {
    await deleteVideo(target.id);
    removeVideoFromList(target.id);
    videoPendingDelete.value = null;
  } catch (err) {
    deleteGridError.value = (err as Error).message;
  } finally {
    deletingFromGrid.value = false;
  }
}

/** Called by PlayerView/WatchView once they've deleted the video that's open in the popup. */
function onVideoDeleted(id: string) {
  removeVideoFromList(id);
}

function goToCast(video: VideoDTO) {
  router.push({ name: "player", params: { id: video.id } });
}

function goToWatch(video: VideoDTO) {
  router.push({ name: "watch", params: { id: video.id } });
}

onMounted(async () => {
  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && hasMoreVideos.value) {
        loadMoreVideos();
      }
    },
    { rootMargin: "800px" } // start loading the next 100 well before you actually hit bottom
  );
  if (scrollSentinel.value) sentinelObserver.observe(scrollSentinel.value);

  fetchServerInfo()
    .then((info) => {
      recentMonths.value = info.recentMonths;
    })
    .catch(() => {
      /* not critical — the label just falls back to the default of 3 */
    });
  await load();
});

onBeforeUnmount(() => {
  sentinelObserver?.disconnect();
});
</script>

<template>
  <div class="container">
    <header class="app-header">
      <h1>📺 Screen Cast</h1>
      <div class="header-actions">
        <label
          class="icon-toggle"
          :class="{ active: includesOld, disabled: rescanning }"
          :title="`Incluir también vídeos con más de ${recentMonths} meses (el escaneo puede tardar más)`"
        >
          <input type="checkbox" :checked="includesOld" :disabled="rescanning" @change="onToggleIncludeOld" />
          <svg
            class="icon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
          </svg>
        </label>

        <button class="btn secondary" :disabled="rescanning" @click="rescan(includesOld)">
          <svg
            class="icon"
            :class="{ spinning: rescanning }"
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
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          <span class="btn-label">{{ rescanning ? "Escaneando…" : "Actualizar biblioteca" }}</span>
        </button>

        <button class="btn secondary" @click="router.push({ name: 'settings' })">
          <span class="icon emoji">🎨</span>
          <span class="btn-label">Ajustes</span>
        </button>
      </div>
    </header>

    <input
      v-model="searchQuery"
      type="search"
      class="search-input"
      placeholder="Buscar vídeos por título…"
      aria-label="Buscar vídeos"
    />

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="loading" class="empty-state">Cargando biblioteca…</div>

    <div v-else-if="videos.length === 0" class="empty-state">
      No se encontró ningún vídeo. Revisa <code>MEDIA_DIRS</code> en <code>server/.env</code>
      <template v-if="!includesOld">
        , o puede que tus vídeos tengan más de {{ recentMonths }} meses — actívalo con el filtro de arriba
      </template>
      y pulsa el icono de actualizar.
    </div>

    <div v-else-if="filteredVideos.length === 0" class="empty-state">
      Ningún vídeo coincide con «{{ searchQuery }}».
    </div>

    <template v-else>
      <div class="video-grid">
        <div v-for="video in visibleVideos" :key="video.id" class="video-card">
          <div class="video-thumb">
            <img
              v-if="!thumbnailFailed.has(video.id)"
              :src="thumbnailUrl(video.id)"
              :alt="video.title"
              loading="lazy"
              @error="onThumbnailError(video.id)"
            />
            <div v-else class="video-thumb-placeholder">🎬</div>
            <span v-if="video.durationSec" class="thumb-duration">{{ formatDuration(video.durationSec) }}</span>
            <button
              class="thumb-delete"
              type="button"
              title="Eliminar vídeo"
              aria-label="Eliminar vídeo"
              @click.stop="requestDelete(video)"
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
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
            </button>
          </div>
          <div class="video-title">{{ video.title }}</div>
          <div class="video-meta">
            <span v-if="video.subtitles.length === 0" class="badge danger">No tiene subtítulos</span>
            <span v-if="video.needsProcessing" class="badge warn" title="Se reempaquetará antes de castear">
              se preparará al castear
            </span>
          </div>
          <div class="video-actions">
            <button class="btn secondary" @click="goToCast(video)">📡 Castear</button>
            <button class="btn secondary" @click="goToWatch(video)">▶ Reproducir</button>
          </div>
        </div>
      </div>

      <div v-if="hasMoreVideos" ref="scrollSentinel" class="load-more-sentinel">Cargando más vídeos…</div>
    </template>
  </div>

  <Modal v-if="activeModal" @close="closeModal">
    <PlayerView v-if="activeModal === 'player'" @deleted="onVideoDeleted" />
    <WatchView v-else-if="activeModal === 'watch'" @deleted="onVideoDeleted" />
  </Modal>

  <ConfirmDialog
    v-if="videoPendingDelete"
    title="Eliminar vídeo"
    :message="`Se eliminará «${videoPendingDelete.title}» y todos sus archivos en caché. Esta acción no se puede deshacer.`"
    :busy="deletingFromGrid"
    :error="deleteGridError"
    @confirm="confirmDeleteFromGrid"
    @close="cancelDelete"
  />
</template>
