// notmoviebox — watch history + resume positions (localStorage).
//
// One ordered store backs both the History view and "start where you left off".
// Each entry carries the display metadata alongside the playback position, so a
// history card can show how far in you are without a second lookup, and the
// player can resume from the same record.

const KEY = "nmb_history";
const MAX = 80;

function readAll() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((e) => e && e.subjectId) : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* quota or private mode — history is best-effort */
  }
}

/** Newest first. */
export function getHistory() {
  return readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getEntry(subjectId) {
  if (!subjectId) return null;
  return readAll().find((e) => String(e.subjectId) === String(subjectId)) || null;
}

/**
 * Resume info for the player / detail page: `{ time, se, ep, duration }`.
 * Falls back to the legacy `nmb_progress_<id>` keys written by older builds.
 */
export function getProgress(subjectId) {
  if (!subjectId) return null;
  const e = getEntry(subjectId);
  if (e) return { time: e.position || 0, se: e.se || 0, ep: e.ep || 0, duration: e.duration || 0 };
  try {
    const legacy = JSON.parse(localStorage.getItem("nmb_progress_" + subjectId) || "null");
    if (legacy?.time) return { time: legacy.time, se: legacy.se || 0, ep: legacy.ep || 0, duration: 0 };
  } catch {
    /* ignore */
  }
  return null;
}

/** Create or move an entry to the front of the history. */
export function recordWatch(entry) {
  if (!entry?.subjectId) return;
  const list = readAll();
  const i = list.findIndex((e) => String(e.subjectId) === String(entry.subjectId));
  const prev = i >= 0 ? list[i] : {};
  const next = {
    subjectId: String(entry.subjectId),
    subjectType: entry.subjectType ?? prev.subjectType ?? 1,
    title: entry.title || prev.title || "Untitled",
    detailPath: entry.detailPath || prev.detailPath || "",
    cover: entry.cover || prev.cover || "",
    se: entry.se ?? prev.se ?? 0,
    ep: entry.ep ?? prev.ep ?? 0,
    position: entry.position ?? prev.position ?? 0,
    duration: entry.duration || prev.duration || 0,
    updatedAt: Date.now(),
  };
  if (i >= 0) list.splice(i, 1);
  list.unshift(next);
  writeAll(list);
}

export function removeEntry(subjectId) {
  writeAll(readAll().filter((e) => String(e.subjectId) !== String(subjectId)));
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
    // legacy per-title progress keys from older builds
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("nmb_progress_")) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

export function percentWatched(e) {
  if (!e?.duration) return 0;
  return Math.max(0, Math.min(100, (e.position / e.duration) * 100));
}

/** "1h 12m left" / "8m left" / "Watched" — for the card subtitle. */
export function remainingLabel(e) {
  if (!e?.duration) return "";
  const left = e.duration - (e.position || 0);
  if (left <= 5) return "Watched";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m left`;
  return `${Math.floor(left)}s left`;
}
