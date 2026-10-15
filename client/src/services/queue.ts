import { reactive } from "vue";

/**
 * "Up next" queue: videos to autoplay, in order, once the current one ends
 * (on the TV or in the browser). Kept per device in localStorage — it's
 * meant for the device you're casting/watching from — and synced across
 * this device's open tabs. Titles are stored alongside ids so the popups
 * can show what's next without fetching it.
 */
export interface QueueItem {
  id: string;
  title: string;
}

const STORAGE_KEY = "screen-cast:queue";

function readStored(): QueueItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueueItem => typeof item?.id === "string" && typeof item?.title === "string"
    );
  } catch {
    return []; // private mode / blocked storage / corrupt JSON — just start empty
  }
}

export const queueState = reactive<{ items: QueueItem[] }>({ items: readStored() });

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queueState.items));
  } catch {
    /* storage unavailable — the queue still works for this tab */
  }
}

// Another tab changed the queue.
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) queueState.items = readStored();
});

/** 1-based position in the queue, or null when the video isn't queued. */
export function queuePosition(id: string): number | null {
  const index = queueState.items.findIndex((item) => item.id === id);
  return index === -1 ? null : index + 1;
}

export function addToQueue(item: QueueItem): void {
  if (queuePosition(item.id) !== null) return;
  queueState.items.push({ id: item.id, title: item.title });
  persist();
}

export function removeFromQueue(id: string): void {
  const before = queueState.items.length;
  queueState.items = queueState.items.filter((item) => item.id !== id);
  if (queueState.items.length !== before) persist();
}

export function toggleQueued(item: QueueItem): void {
  if (queuePosition(item.id) === null) addToQueue(item);
  else removeFromQueue(item.id);
}

/**
 * The video that will play next, without taking it off the queue.
 * `currentId` skips the video that's open right now (it leaves the queue
 * once it actually starts playing).
 */
export function peekNext(currentId?: string): QueueItem | null {
  return queueState.items.find((item) => item.id !== currentId) ?? null;
}

/** Takes the next video off the queue (it's about to play). */
export function takeNext(): QueueItem | null {
  const next = queueState.items.shift() ?? null;
  if (next) persist();
  return next;
}
