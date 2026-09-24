<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  deletePreparedVideo,
  deleteVideo,
  fetchLibrary,
  fetchServerInfo,
  prepareVideo,
  rescanLibrary,
  thumbnailUrl,
} from "@/services/api";
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
  // Keep ?carpeta= so closing the popup lands back in the same folder.
  router.push({ name: "library", query: route.query });
}

// Folder navigation is derived entirely from each video's relativePath —
// the server doesn't know about folders at all. Since the server only
// indexes videos inside the "recent" window (unless the filter is on),
// a folder whose videos are all too old simply never shows up. With several
// MEDIA_DIRS, subfolders that share a name/path are merged into one.
// The current folder lives in the URL (?carpeta=a/b) so it's deep-linkable
// and the browser back button walks back up the tree.
interface FolderItem {
  name: string;
  /** Path segments from the library root, e.g. ["Series", "Show"]. */
  path: string[];
  videoCount: number;
  /** Newest video inside (at any depth) — used for the cover thumbnail and sorting. */
  newest: VideoDTO;
}

/** Splits a relativePath (Windows or POSIX separators) into its folder segments, without the file name. */
function folderSegments(video: VideoDTO): string[] {
  return video.relativePath.split(/[\\/]+/).filter(Boolean).slice(0, -1);
}

const currentPath = computed<string[]>(() => {
  const raw = route.query.carpeta;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value.split("/").filter(Boolean) : [];
});

function isInsidePath(segments: string[], path: string[]): boolean {
  return path.every((part, i) => segments[i] === part);
}

/** Every video under the current folder, at any depth (in the server's newest-first order). */
const videosUnderCurrentPath = computed(() =>
  videos.value.filter((video) => isInsidePath(folderSegments(video), currentPath.value))
);

const currentFolders = computed<FolderItem[]>(() => {
  const depth = currentPath.value.length;
  const byName = new Map<string, FolderItem>();
  for (const video of videosUnderCurrentPath.value) {
    const segments = folderSegments(video);
    if (segments.length <= depth) continue;
    const name = segments[depth]!;
    const existing = byName.get(name);
    if (existing) {
      existing.videoCount += 1;
      if (video.mtimeMs > existing.newest.mtimeMs) existing.newest = video;
    } else {
      byName.set(name, { name, path: [...currentPath.value, name], videoCount: 1, newest: video });
    }
  }
  // Newest folder first, matching how videos themselves are ordered.
  return Array.from(byName.values()).sort((a, b) => b.newest.mtimeMs - a.newest.mtimeMs);
});

const currentVideos = computed(() =>
  videosUnderCurrentPath.value.filter((video) => folderSegments(video).length === currentPath.value.length)
);

function openFolder(folder: FolderItem) {
  searchQuery.value = "";
  router.push({ name: "library", query: { carpeta: folder.path.join("/") } });
}

function goToFolderPath(path: string[]) {
  router.push({ name: "library", query: path.length ? { carpeta: path.join("/") } : {} });
}

function goUpOneLevel() {
  goToFolderPath(currentPath.value.slice(0, -1));
}

// While searching, folders are flattened: every matching video inside the
// current folder (including its subfolders) is listed directly, so a search
// from the top level still finds everything.
const isSearching = computed(() => searchQuery.value.trim() !== "");

const filteredFolders = computed(() => (isSearching.value ? [] : currentFolders.value));

const filteredVideos = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return currentVideos.value;
  return videosUnderCurrentPath.value.filter((video) => video.title.toLowerCase().includes(q));
});

const totalItems = computed(() => filteredFolders.value.length + filteredVideos.value.length);

// Folders always come first; pagination counts folders and videos together.
const visibleFolders = computed(() => filteredFolders.value.slice(0, visibleCount.value));
const visibleVideos = computed(() =>
  filteredVideos.value.slice(0, Math.max(0, visibleCount.value - filteredFolders.value.length))
);
const hasMoreVideos = computed(() => visibleCount.value < totalItems.value);

function loadMoreVideos() {
  visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, totalItems.value);
}

// A new search, a fresh scan result or entering another folder should
// always start back at the top page rather than keeping whatever count
// scrolling had reached before.
watch([searchQuery, videos, currentPath], () => {
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

// Ids currently being remuxed/transcoded for browser playback ahead of
// time, via the thumbnail's "prepare" button — so its icon can switch to an
// hourglass while the request is in flight, without waiting for someone to
// actually open the Reproducir popup first.
const preparingVideos = reactive(new Set<string>());

async function prepareForBrowser(video: VideoDTO) {
  if (video.browserReady || preparingVideos.has(video.id)) return;
  preparingVideos.add(video.id);
  error.value = null;
  try {
    // No audioTrackIndex here on purpose: the grid has no per-video track
    // picker, so this leaves it to the server's own default
    // (video.defaultAudioTrackIndex — e.g. Japanese for a dual-audio
    // release), the same one isBrowserReady/deleteBrowserCache below check
    // against.
    await prepareVideo(video.id, { forBrowser: true });
    // Optimistic update — video.browserReady would otherwise only refresh on
    // the next /api/library fetch (a manual rescan), so the tick wouldn't
    // show up until then even though the file is already sitting in cache.
    video.browserReady = true;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    preparingVideos.delete(video.id);
  }
}

// Ids currently having their cached browser remux deleted, via a click on
// the ready checkmark — mirrors preparingVideos above.
const removingBrowserCache = reactive(new Set<string>());

async function removeBrowserCache(video: VideoDTO) {
  if (removingBrowserCache.has(video.id)) return;
  removingBrowserCache.add(video.id);
  error.value = null;
  try {
    const { removed } = await deletePreparedVideo(video.id, { forBrowser: true });
    // Nothing to flip back to the "prepare" button for a video that never
    // needed a cache file in the first place (it plays directly) — the
    // server reports removed:false and it just stays ready.
    if (removed) video.browserReady = false;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    removingBrowserCache.delete(video.id);
  }
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
  router.push({ name: "player", params: { id: video.id }, query: route.query });
}

function goToWatch(video: VideoDTO) {
  router.push({ name: "watch", params: { id: video.id }, query: route.query });
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
            <circle cx="12" cy="12" r="3"></circle>
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            ></path>
          </svg>
          <span class="btn-label">Configuración</span>
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

    <nav v-if="currentPath.length > 0" class="folder-bar" aria-label="Carpeta actual">
      <button class="btn secondary" type="button" title="Volver a la carpeta anterior" @click="goUpOneLevel">
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
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
        <span>Volver</span>
      </button>
      <ol class="breadcrumb">
        <li><a href="#" @click.prevent="goToFolderPath([])">Biblioteca</a></li>
        <li v-for="(part, i) in currentPath" :key="i">
          <span v-if="i === currentPath.length - 1" aria-current="page">📁 {{ part }}</span>
          <a v-else href="#" @click.prevent="goToFolderPath(currentPath.slice(0, i + 1))">{{ part }}</a>
        </li>
      </ol>
    </nav>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="loading" class="empty-state">Cargando biblioteca…</div>

    <div v-else-if="videos.length === 0" class="empty-state">
      No se encontró ningún vídeo. Revisa <code>MEDIA_DIRS</code> en <code>server/.env</code>
      <template v-if="!includesOld">
        , o puede que tus vídeos tengan más de {{ recentMonths }} meses — actívalo con el filtro de arriba
      </template>
      y pulsa el icono de actualizar.
    </div>

    <div v-else-if="totalItems === 0 && isSearching" class="empty-state">
      Ningún vídeo coincide con «{{ searchQuery }}».
    </div>

    <div v-else-if="totalItems === 0" class="empty-state">
      Esta carpeta no contiene vídeos
      <template v-if="!includesOld">recientes (de los últimos {{ recentMonths }} meses)</template>.
    </div>

    <template v-else>
      <div class="video-grid">
        <button
          v-for="folder in visibleFolders"
          :key="folder.path.join('/')"
          type="button"
          class="video-card folder-card"
          :title="`Abrir carpeta «${folder.name}»`"
          @click="openFolder(folder)"
        >
          <div class="video-thumb">
            <img
              v-if="!thumbnailFailed.has(folder.newest.id)"
              :src="thumbnailUrl(folder.newest.id)"
              alt=""
              loading="lazy"
              @error="onThumbnailError(folder.newest.id)"
            />
            <div v-else class="video-thumb-placeholder">📁</div>
            <span class="folder-badge" aria-hidden="true">📁</span>
            <span class="thumb-duration">{{ folder.videoCount }} {{ folder.videoCount === 1 ? "vídeo" : "vídeos" }}</span>
          </div>
          <div class="video-title">{{ folder.name }}</div>
        </button>
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
              v-if="video.browserReady"
              class="thumb-ready"
              type="button"
              :disabled="removingBrowserCache.has(video.id)"
              :title="
                removingBrowserCache.has(video.id)
                  ? 'Eliminando copia cacheada…'
                  : 'Listo para reproducir en el navegador — clic para eliminar la copia cacheada'
              "
              :aria-label="
                removingBrowserCache.has(video.id)
                  ? 'Eliminando copia cacheada'
                  : 'Listo para reproducir en el navegador, eliminar copia cacheada'
              "
              @click.stop="removeBrowserCache(video)"
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </button>
            <button
              v-else
              class="thumb-prepare"
              type="button"
              :disabled="preparingVideos.has(video.id)"
              :title="preparingVideos.has(video.id) ? 'Preparando para el navegador…' : 'Preparar para reproducir en el navegador'"
              :aria-label="preparingVideos.has(video.id) ? 'Preparando para el navegador' : 'Preparar para reproducir en el navegador'"
              @click.stop="prepareForBrowser(video)"
            >
              <span v-if="preparingVideos.has(video.id)" class="thumb-prepare-hourglass" aria-hidden="true">⏳</span>
              <svg
                v-else
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
            </button>
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
