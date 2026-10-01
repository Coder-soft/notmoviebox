// notmoviebox — player.
//
// Adapted from the MovieThon "video grabber" overlay player
// (https://github.com/Coder-soft/moviethon). Custom controls, quality + episode
// switching, HLS/DASH support, single + dual subtitle tracks, resume progress.
//
// Differences from upstream: it is a module, it receives its data/meta instead
// of scraping globals, and every stream URL is routed through the local media
// proxy so signed headers / Referer / CDN cookies are applied server-side.

import { mediaUrl, fmtTime, api } from "./api.js?v=16";
import { getProgress, recordWatch } from "./history.js?v=16";

/* hls.js (414 KB) and dash.js (794 KB) are only needed once you press play, so
   they are loaded on demand instead of blocking every page load. */
const vendorLoads = {};
function loadVendor(src) {
  if (!vendorLoads[src]) {
    vendorLoads[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }
  return vendorLoads[src];
}

function mi(n) {
  const icons = {
    smart_display: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    play_arrow: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
    skip_previous: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
    skip_next: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
    volume_up: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    volume_down: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>',
    volume_off: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    view_list: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
    pip: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.87a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>',
    subtitles: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>',
  };
  return icons[n] || n;
}

/* ── Subtitle format conversion ───────────────────────────────────────────── */

function srtToVtt(srt) {
  return (
    "WEBVTT\n\n" +
    srt
      .replace(/(\d\d:\d\d:\d\d)[,.](\d+)/g, (_m, time, ms) => {
        let p = ms.slice(0, 3);
        if (ms.length === 1) p = ms + "00";
        if (ms.length === 2) p = ms + "0";
        return time + "," + p;
      })
      .replace(/\{\\([ibu])\}/g, "</$1>")
      .replace(/\{\\([ibu])1\}/g, "<$1>")
      .replace(/\{([ibu])\}/g, "<$1>")
      .replace(/\{\/([ibu])\}/g, "</$1>")
      .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")
      .replace(/\{[\s\S]*?\}/g, "")
  );
}

function assToVtt(ass) {
  const re = new RegExp(
    "Dialogue:\\s\\d," +
      "(\\d+:\\d\\d:\\d\\d.\\d\\d)," +
      "(\\d+:\\d\\d:\\d\\d.\\d\\d)," +
      "([^,]*),([^,]*)," +
      "(?:[^,]*,){4}" +
      "([\\s\\S]*)$",
    "i"
  );
  const fmt = (t) => {
    if (!t) return "00:00:00.000";
    return t
      .split(/[:.]/)
      .map((part, idx, arr) =>
        idx === arr.length - 1
          ? part.length === 1
            ? "." + part + "00"
            : part.length === 2
            ? "." + part + "0"
            : "." + part
          : part.length === 1
          ? (idx === 0 ? "0" : ":0") + part
          : idx === 0
          ? part
          : ":" + part
      )
      .join("");
  };
  return (
    "WEBVTT\n\n" +
    ass
      .split(/\r?\n/)
      .map((line) => {
        const m = line.match(re);
        if (!m) return null;
        return {
          start: fmt(m[1].trim()),
          end: fmt(m[2].trim()),
          text: m[5].replace(/\{[\s\S]*?\}/g, "").replace(/\\N/g, "\n").trim(),
        };
      })
      .filter(Boolean)
      .map((c, i) => i + 1 + "\n" + c.start + " --> " + c.end + "\n" + c.text)
      .join("\n\n")
  );
}

const LANGUAGE_MAP = {
  English: "en", "中文(简体)": "zh", 中文: "zh", 日本語: "ja", 한국어: "ko",
  Français: "fr", Deutsch: "de", Español: "es", Italiano: "it", Português: "pt",
  Русский: "ru", العربية: "ar", हिन्दी: "hi", ภาษาไทย: "th",
  "Bahasa Indonesia": "id", "Việt Nam": "vi", Türkçe: "tr", Nederlands: "nl",
  Polski: "pl", اُردُو: "ur", Urdu: "ur",
};

function getLangCode(lanName) {
  return (
    LANGUAGE_MAP[lanName] ||
    (lanName || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 4) ||
    "unk"
  );
}

function parseVttTime(t) {
  t = t.replace(/,/g, ".");
  const p = t.split(":");
  if (p.length === 3) return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2]);
  if (p.length === 2) return +p[0] * 60 + parseFloat(p[1]);
  return parseFloat(p[0]) || 0;
}

function parseVttCues(vtt) {
  const cues = [];
  let cur = null;
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || line.startsWith("WEBVTT") || /^\d+$/.test(line)) continue;
    if (line.includes("-->")) {
      if (cur) cues.push(cur);
      const [a, b] = line.split("-->");
      cur = { start: parseVttTime(a.trim()), end: parseVttTime(b.trim()), text: "" };
    } else if (cur && !line.includes(":")) {
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  if (cur) cues.push(cur);
  return cues;
}

function fmtVttTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function cuesToVtt(cues) {
  if (!cues?.length) return "";
  return (
    "WEBVTT\n\n" +
    cues
      .map((c, i) => `${i + 1}\n${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${c.text}`)
      .join("\n\n")
  );
}

function mergeDual(v1, v2) {
  if (!v1) return v2 || "";
  if (!v2) return v1 || "";
  const c1 = parseVttCues(v1);
  const c2 = parseVttCues(v2);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < c1.length || j < c2.length) {
    const a = c1[i];
    const b = c2[j];
    if (!b) out.push(a), i++;
    else if (!a) out.push(b), j++;
    else if (a.end <= b.start) out.push(a), i++;
    else if (b.end <= a.start) out.push(b), j++;
    else {
      out.push({
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
        text: a.text + "\n" + b.text,
      });
      i++;
      j++;
    }
  }
  return cuesToVtt(out);
}

async function fetchSubtitle(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  const ext = (url.split("?").shift().split(".").pop() || "").toLowerCase();
  if (ext === "srt") return srtToVtt(text);
  if (ext === "ass" || ext === "ssa") return assToVtt(text);
  return text;
}

/* ── Player ───────────────────────────────────────────────────────────────── */

/* The BFF's DASH ladder is HEVC (`…_1080_h265_…`). Where HEVC cannot be
   decoded, dash.js silently drops the video AdaptationSet and plays audio over
   a black screen, so prefer a source this browser can actually decode. */
function canPlayHevc() {
  try {
    const ms = window.MediaSource;
    if (ms && ms.isTypeSupported) {
      return (
        ms.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
        ms.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')
      );
    }
  } catch {
    /* ignore */
  }
  return false;
}

function looksHevc(src) {
  return /h\.?265|hevc|hvc1|hev1/i.test(src.url || "");
}

function sourcesFrom(data) {
  // Play whatever the API actually handed over — every source that carries a
  // URL, highest resolution first. This mirrors moviethon: a rendition marked
  // `vipLocked` is still usable when the API returns its URL and signed header.
  const all = [];
  (data.streams || []).forEach((s) => {
    if (s.url) all.push({ type: "MP4", res: s.resolutions, url: s.url, vipLocked: s.vipLocked, id: s.id });
  });
  (data.hls || []).forEach((s) => {
    if (s.url) all.push({ type: "HLS", res: s.resolutions, url: s.url, signHeaderKey: s.signHeaderKey, signCookie: s.signCookie, vipLocked: s.vipLocked, id: s.id });
  });
  (data.dash || []).forEach((s) => {
    if (s.url) all.push({ type: "DASH", res: s.resolutions, url: s.url, signHeaderKey: s.signHeaderKey, signCookie: s.signCookie, prePlayApi: s.prePlayApi, vipLocked: s.vipLocked, id: s.id });
  });
  all.sort((a, b) => parseInt(b.res, 10) - parseInt(a.res, 10));
  // Keep the resolution order, but move sources this browser cannot decode to
  // the back, so a playable H.264 rendition is chosen first. (sort is stable,
  // so the highest-to-lowest order is preserved within each group.)
  if (!canPlayHevc()) all.sort((a, b) => (looksHevc(a) ? 1 : 0) - (looksHevc(b) ? 1 : 0));
  return { sources: all, type: all[0]?.type || "MP4" };
}

function defaultIndex() {
  return 0; // sources are sorted highest-resolution first
}

function epList(season) {
  if (season.allEp) return season.allEp.split(",").map(Number);
  if (season.maxEp) return Array.from({ length: season.maxEp }, (_, i) => i + 1);
  return [];
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Open the player overlay.
 * @param {object} opts
 * @param {object} opts.data   initial play payload (streams/hls/dash)
 * @param {object} opts.meta   { subjectId, subjectType, title, detailPath, seasons, curSe, curEp }
 * @param {function} opts.getPlayData  async (se, ep) => play payload
 * @param {function} opts.getCaptions  async ({format,id,subjectId,detailPath}) => captions[]
 * @param {function} opts.onClose
 */
export function openPlayer(opts) {
  const meta = { ...opts.meta };
  let playData = opts.data;
  let entries = sourcesFrom(playData).sources;

  const isSeries = meta.subjectType === 2 && (meta.seasons || []).length > 0;

  // pause anything already playing on the page
  document.querySelectorAll("video,audio").forEach((m) => {
    try {
      m.pause();
    } catch {
      /* ignore */
    }
  });

  const overlay = document.createElement("div");
  overlay.id = "mt-grabber-overlay";
  const ps = sourcesFrom(playData);
  const epBadge = isSeries && meta.curSe && meta.curEp ? `S${meta.curSe} · E${meta.curEp}` : "";

  overlay.innerHTML = [
    '<div id="mt-topbar">',
    '<div class="mt-top-left">',
    '<button id="mt-close-btn" class="mt-round-btn" title="Close (Esc)">' + mi("close") + "</button>",
    '<div class="mt-title-block">',
    '<div class="mt-title" title="' + esc(meta.title || "") + '">' + esc(meta.title || "") + "</div>",
    '<div class="mt-subline">',
    epBadge ? '<span class="mt-ep-badge" id="mt-ep-badge">' + epBadge + "</span>" : "",
    '<span class="mt-source-tag" id="mt-source-type">' + ps.type + "</span>",
    '<span class="mt-res-tag" id="mt-res-tag"></span>',
    "</div></div></div>",
    '<div class="mt-top-actions">',
    isSeries ? '<button id="mt-toggle-ep" class="mt-pill-btn" title="Episodes">' + mi("view_list") + "<span>Episodes</span></button>" : "",
    '<button id="mt-settings-btn" class="mt-round-btn" title="Settings">' + mi("settings") + "</button>",
    "</div></div>",
    '<div id="mt-body">',
    '<div id="mt-video-wrap">',
    '<video id="mt-video" autoplay playsinline></video>',
    '<div id="mt-subtitle-overlay"></div>',
    '<div id="mt-loading"><span class="mt-spinner"></span><span id="mt-loading-text">Loading…</span></div>',
    '<button id="mt-center-play" class="mt-center-play" title="Play">' + mi("play_arrow") + "</button>",
    '<div id="mt-controls">',
    '<div id="mt-progress" class="mt-progress">',
    '<div id="mt-progress-buffered" class="mt-progress-buffered"></div>',
    '<div id="mt-progress-played" class="mt-progress-played"></div>',
    '<div id="mt-progress-thumb" class="mt-progress-thumb"></div>',
    '<div id="mt-progress-tooltip" class="mt-progress-tooltip">0:00</div>',
    "</div>",
    '<div class="mt-controls-row">',
    '<button id="mt-play-btn" class="mt-ctrl-btn mt-primary" title="Play/Pause (space)">' + mi("play_arrow") + "</button>",
    '<button id="mt-back-btn" class="mt-ctrl-btn" title="Back 10s (←)">' + mi("skip_previous") + "</button>",
    '<button id="mt-fwd-btn" class="mt-ctrl-btn" title="Forward 10s (→)">' + mi("skip_next") + "</button>",
    '<span id="mt-time-display" class="mt-time">0:00 / 0:00</span>',
    '<div class="mt-spacer"></div>',
    '<div class="mt-volume-wrap">',
    '<button id="mt-mute-btn" class="mt-ctrl-btn" title="Mute (m)">' + mi("volume_up") + "</button>",
    '<input id="mt-volume-slider" class="mt-volume-slider" type="range" min="0" max="1" step="0.01" value="1">',
    "</div>",
    '<button id="mt-pip-btn" class="mt-ctrl-btn" title="Picture-in-picture">' + mi("pip") + "</button>",
    '<button id="mt-fullscreen-btn" class="mt-ctrl-btn" title="Fullscreen (f)">' + mi("fullscreen") + "</button>",
    "</div></div>",
    "</div>",
    isSeries
      ? '<div id="mt-ep-panel">' +
        '<div class="mt-sheet-head">' +
        '<span class="mt-sheet-title">' + mi("view_list") + " Episodes</span>" +
        '<button id="mt-close-ep" class="mt-round-btn mt-small" title="Hide">' + mi("close") + "</button>" +
        "</div>" +
        '<div id="mt-season-tabs"></div>' +
        '<div id="mt-ep-grid"></div>' +
        "</div>"
      : "",
    "</div>",
    '<div id="mt-settings-panel">',
    '<div class="mt-sheet-head">',
    '<span class="mt-sheet-title">' + mi("settings") + " Settings</span>",
    '<button id="mt-settings-close" class="mt-round-btn mt-small" title="Hide">' + mi("close") + "</button>",
    "</div>",
    '<div class="mt-settings-body">',
    '<label class="mt-field"><span class="mt-field-label">Quality</span><select id="mt-quality-select" class="mt-select"></select></label>',
    '<label class="mt-field"><span class="mt-field-label">Speed</span><select id="mt-speed-select" class="mt-select">',
    '<option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>',
    "</select></label>",
    '<label class="mt-field"><span class="mt-field-label">Subtitles</span><select id="mt-subtitle-select" class="mt-select"><option value="">Off</option></select></label>',
    '<label class="mt-field"><span class="mt-field-label">Second subtitles</span><select id="mt-dual-subtitle-select" class="mt-select"><option value="">Off</option></select></label>',
    "</div></div>",
    '<div id="mt-error"></div>',
  ].join("");

  document.body.appendChild(overlay);
  // Lets CSS drop the app chrome's backdrop-filter while the player is up, so
  // nothing keeps compositing a blur behind an opaque full-screen overlay.
  document.body.classList.add("mt-playing");

  const $ = (sel) => overlay.querySelector(sel);
  const video = $("#mt-video");
  const loading = $("#mt-loading");
  const errorEl = $("#mt-error");
  const statusEl = $("#mt-source-type");
  const sel = $("#mt-quality-select");
  const videoWrap = $("#mt-video-wrap");
  const topbarEl = $("#mt-topbar");
  const controlsEl = $("#mt-controls");
  const loadingText = $("#mt-loading-text");
  const settingsPanel = $("#mt-settings-panel");

  function showLoading(text) {
    if (loadingText) loadingText.textContent = text || "Loading…";
    loading.style.display = "flex";
  }
  function hideLoading() {
    loading.style.display = "none";
  }

  let currentIdx = 0;
  let hls = null;
  let dash = null;
  const sub = { captions: [], primary: null, secondary: null };

  function qualityOptions(sources) {
    sel.innerHTML = "";
    sources.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.innerHTML = `${s.type} ${s.res}p${s.vipLocked ? " " + mi("lock") : ""}`;
      sel.appendChild(o);
    });
  }
  qualityOptions(ps.sources);
  currentIdx = defaultIndex();
  sel.value = currentIdx;

  function proxyFor(src) {
    return mediaUrl(src.url, {
      signHeaderKey: src.signHeaderKey,
      signCookie: src.signCookie,
      prePlayApi: src.prePlayApi,
    });
  }

  let switching = false;

  // If a source fails (e.g. a codec the browser cannot decode), fall through to
  // the next-best source the API provided instead of giving up.
  function tryNext(msg) {
    if (switching) return;
    switching = true;
    const list = sourcesFrom(playData).sources;
    const next = currentIdx + 1;
    if (next < list.length) {
      sel.value = next;
      loadSource(next);
    } else {
      hideLoading();
      errorEl.textContent = msg;
      errorEl.style.display = "block";
    }
    switching = false;
  }

  function loadSource(idx) {
    const parsed = sourcesFrom(playData);
    const src = parsed.sources[parseInt(idx, 10)];
    if (!src) return;
    currentIdx = parseInt(idx, 10);
    statusEl.textContent = src.type;
    // fresh source: don't judge it on the previous one's health
    hasPlayed = false;
    slowRuns = 0;
    fpsSample = { n: frameCount(), at: 0 };
    video.pause();
    video.removeAttribute("src");
    video.load();
    errorEl.style.display = "none";
    if (hls) hls.destroy(), (hls = null);
    if (dash) dash.reset(), (dash = null);

    const url = proxyFor(src);
    if (src.type === "MP4") {
      showLoading();
      video.src = url;
      video.load();
      video.play().catch(() => {});
      video.addEventListener("loadeddata", function on() {
        hideLoading();
        video.removeEventListener("loadeddata", on);
      }, { once: true });
      video.addEventListener("error", function onErr() {
        video.removeEventListener("error", onErr);
        tryNext("Could not play this source.");
      }, { once: true });
    } else if (src.type === "HLS") {
      loadHls(url);
    } else {
      loadDash(url);
    }
  }

  function loadHls(url) {
    showLoading();
    const ready = window.Hls ? Promise.resolve() : loadVendor("/vendor/hls.min.js");
    ready
      .then(() => {
        if (!window.Hls || !window.Hls.isSupported()) return tryNext("HLS is not supported in this browser.");
        hls = new window.Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          hideLoading();
          video.play().catch(() => {});
        });
        hls.on(window.Hls.Events.LEVEL_SWITCHED, () => updateResTag());
        hls.on(window.Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) {
            try {
              hls.destroy();
            } catch {
              /* ignore */
            }
            hls = null;
            tryNext("HLS error: " + (d.details || d.type || "unknown"));
          }
        });
      })
      .catch(() => tryNext("Failed to load hls.js."));
  }

  function loadDash(url) {
    showLoading();
    const ready = window.dashjs ? Promise.resolve() : loadVendor("/vendor/dash.all.min.js");
    ready
      .then(() => {
        if (!window.dashjs || !window.dashjs.MediaPlayer) return tryNext("dash.js is not available.");
        try {
          dash = window.dashjs.MediaPlayer().create();
          // Start modest and let ABR climb to the best rendition the link can
          // actually sustain. Pinning the top rendition (and disabling ABR, as
          // this used to) means a link that can't hold 1080p buffers forever
          // with no way back down — the "stops and never resumes" symptom.
          try {
            dash.updateSettings({
              streaming: { abr: { initialBitrate: { video: 1_200_000 } } },
            });
          } catch {
            /* older dash.js */
          }
          dash.initialize(video, url, true);
          dash.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            let list = [];
            try {
              list = dash.getBitrateInfoListFor("video") || [];
            } catch {
              /* ignore */
            }
            // No video rendition survived dash.js's capability filter (an HEVC
            // ladder in a browser without HEVC): it would play audio over a
            // black screen and never raise an error, so stop it and move on.
            if (!list.length) {
              try {
                dash.reset();
              } catch {
                /* ignore */
              }
              dash = null;
              return tryNext("No supported video track in this stream.");
            }
          });
          dash.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
            try {
              dash.reset();
            } catch {
              /* ignore */
            }
            dash = null;
            tryNext("DASH error" + (e?.error?.message ? ": " + e.error.message : ""));
          });
          dash.on(window.dashjs.MediaPlayer.events.CAN_PLAY, () => {
            hideLoading();
          });
          dash.on(window.dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => updateResTag());
        } catch (err) {
          tryNext("DASH error: " + (err?.message || err));
        }
      })
      .catch(() => tryNext("Failed to load dash.js."));
  }

  sel.addEventListener("change", () => loadSource(sel.value));

  /* Health watchdog — one interval, two failure modes that never raise an error:
       1. a stalled fetch: the element reports "loading" forever;
       2. decode-bound playback: ABR only reacts to bandwidth, so a device that
          cannot decode the 1080p HEVC ladder keeps "playing" at single-digit
          fps with the position still advancing.
     Progress is judged by position/buffered end, smoothness by presented
     frames. Each source is only abandoned once, so a deliberate pick sticks. */
  function bufferedEnd() {
    try {
      return video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    } catch {
      return 0;
    }
  }

  let frames = 0;
  let fpsSample = { n: 0, at: 0 };
  let hasPlayed = false;
  let nudges = 0;
  let slowRuns = 0;
  let mark = { t: 0, end: 0, at: Date.now() };
  const heavySources = new Set();

  // rVFC counter, used only where the playback-quality API is unavailable.
  function tickFrame() {
    frames++;
    video.requestVideoFrameCallback(tickFrame);
  }
  if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(tickFrame);

  /* Decoded frames so far. `getVideoPlaybackQuality()` is preferred because it
     reports decode throughput without needing a compositor (rVFC does not tick
     for an offscreen or backgrounded video), and decode throughput is exactly
     what "too heavy for this device" means. */
  function frameCount() {
    try {
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      if (q && typeof q.totalVideoFrames === "number") return q.totalVideoFrames;
    } catch {
      /* ignore */
    }
    return frames;
  }

  function presentedFps() {
    const now = performance.now();
    const n = frameCount();
    if (!fpsSample.at) {
      fpsSample = { n, at: now };
      return null;
    }
    const dt = (now - fpsSample.at) / 1000;
    if (dt < 2) return null;
    const delta = n - fpsSample.n;
    fpsSample = { n, at: now };
    // Zero new frames means we cannot measure (hidden tab, no compositor) —
    // that is not a slow decode, so don't judge it.
    if (delta <= 0) return null;
    return delta / dt;
  }

  video.addEventListener("playing", () => {
    hasPlayed = true;
    nudges = 0;
    slowRuns = 0;
    fpsSample = { n: frameCount(), at: performance.now() };
    mark = { t: video.currentTime, end: bufferedEnd(), at: Date.now() };
  });

  const healthWatch = setInterval(() => {
    // Only judge a stream that has actually started; a slow first load is the
    // loading spinner's job, not the watchdog's.
    if (!hasPlayed || video.paused || video.ended) {
      mark = { t: video.currentTime, end: bufferedEnd(), at: Date.now() };
      fpsSample = { n: frameCount(), at: performance.now() };
      return;
    }

    // 1. decode-bound? (~9s of single-digit fps)
    if (video.readyState >= 2) {
      const fps = presentedFps();
      if (fps !== null && fps < 12) {
        if (++slowRuns >= 3 && !heavySources.has(currentIdx)) {
          heavySources.add(currentIdx);
          slowRuns = 0;
          tryNext("This stream is too heavy for this device — trying a lighter one.");
          return;
        }
      } else {
        slowRuns = 0;
      }
    }

    // 2. network-stalled?
    const end = bufferedEnd();
    if (video.currentTime > mark.t + 0.2 || end > mark.end + 0.5) {
      mark = { t: video.currentTime, end, at: Date.now() };
      nudges = 0;
      return;
    }
    if (Date.now() - mark.at < 15000) return;
    mark.at = Date.now();
    if (nudges++ === 0) {
      try {
        video.currentTime = video.currentTime + 0.1; // make the loader re-request
        video.play().catch(() => {});
      } catch {
        /* ignore */
      }
    } else {
      tryNext("Playback stalled — trying another source.");
    }
  }, 3000);

  // resume / last-episode
  const saved = meta.subjectId ? getProgress(meta.subjectId) : null;
  if (saved?.time) video._pendingSeek = saved.time;

  const needSwitch = saved?.se && saved?.ep && isSeries && (saved.se !== meta.curSe || saved.ep !== meta.curEp);
  if (needSwitch) setTimeout(() => switchToEpisode(saved.se, saved.ep), 0);
  else loadSource(currentIdx);

  /* ── controls ── */
  const playBtn = $("#mt-play-btn");
  const backBtn = $("#mt-back-btn");
  const fwdBtn = $("#mt-fwd-btn");
  const timeDisplay = $("#mt-time-display");
  const muteBtn = $("#mt-mute-btn");
  const volumeSlider = $("#mt-volume-slider");
  const speedSelect = $("#mt-speed-select");
  const pipBtn = $("#mt-pip-btn");
  const fsBtn = $("#mt-fullscreen-btn");
  const centerPlay = $("#mt-center-play");
  const progress = $("#mt-progress");
  const progressBuffered = $("#mt-progress-buffered");
  const progressPlayed = $("#mt-progress-played");
  const progressThumb = $("#mt-progress-thumb");
  const progressTooltip = $("#mt-progress-tooltip");

  function flash(icon) {
    const el = document.createElement("div");
    el.className = "mt-flash-icon";
    el.innerHTML = icon;
    videoWrap.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
  function togglePlay() {
    if (video.paused) video.play().catch(() => {}), flash(mi("play_arrow"));
    else video.pause(), flash(mi("pause"));
  }
  function skipBack() {
    video.currentTime = Math.max(0, video.currentTime - 10);
    flash(mi("skip_previous"));
  }
  function skipFwd() {
    const d = video.duration;
    video.currentTime = isFinite(d) ? Math.min(d, video.currentTime + 10) : video.currentTime + 10;
    flash(mi("skip_next"));
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else overlay.requestFullscreen();
  }
  function updatePlayIcon() {
    const paused = video.paused || video.ended;
    playBtn.innerHTML = paused ? mi("play_arrow") : mi("pause");
    centerPlay.style.display = paused ? "flex" : "none";
    if (paused) {
      topbarEl.classList.remove("mt-hidden");
      controlsEl.classList.remove("mt-hidden");
    }
  }
  function updateVolumeIcon() {
    const v = video.muted ? 0 : video.volume;
    muteBtn.innerHTML = v === 0 ? mi("volume_off") : v < 0.5 ? mi("volume_down") : mi("volume_up");
    volumeSlider.value = v;
  }
  function saveProgress(cur) {
    if (!meta.subjectId || cur <= 5) return;
    const last = video._lastSaved || 0;
    if (Math.abs(cur - last) > 5 || video.paused || video.ended) {
      recordWatch({
        subjectId: meta.subjectId,
        subjectType: meta.subjectType,
        title: meta.title,
        detailPath: meta.detailPath,
        cover: meta.cover,
        se: meta.curSe,
        ep: meta.curEp,
        position: cur,
        duration: isFinite(video.duration) ? video.duration : 0,
      });
      video._lastSaved = cur;
    }
  }
  function updateProgress() {
    const d = video.duration;
    const cur = video.currentTime;
    if (isFinite(d) && d > 0) {
      const pct = Math.min(100, (cur / d) * 100);
      progressPlayed.style.width = pct + "%";
      progressThumb.style.left = pct + "%";
      timeDisplay.textContent = fmtTime(cur) + " / " + fmtTime(d);
    } else {
      timeDisplay.textContent = fmtTime(cur) + " / LIVE";
    }
    try {
      if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        progressBuffered.style.width = (isFinite(d) && d > 0 ? Math.min(100, (end / d) * 100) : 0) + "%";
      }
    } catch {
      /* ignore */
    }
    saveProgress(cur);
  }

  let dragging = false;
  function seek(e) {
    const rect = progress.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const d = video.duration;
    if (isFinite(d) && d > 0) {
      const t = pct * d;
      progressTooltip.textContent = fmtTime(t);
      progressTooltip.style.left = pct * 100 + "%";
      return { pct, t };
    }
    return null;
  }
  progress.addEventListener("pointerdown", (e) => {
    dragging = true;
    progress.classList.add("mt-dragging");
    try {
      progress.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const r = seek(e);
    if (r) {
      video.currentTime = r.t;
      progressPlayed.style.width = r.pct * 100 + "%";
      progressThumb.style.left = r.pct * 100 + "%";
    }
    showChrome();
  });
  progress.addEventListener("pointermove", (e) => {
    const r = seek(e);
    if (dragging && r) {
      video.currentTime = r.t;
      progressPlayed.style.width = r.pct * 100 + "%";
      progressThumb.style.left = r.pct * 100 + "%";
    }
  });
  progress.addEventListener("pointerup", (e) => {
    dragging = false;
    progress.classList.remove("mt-dragging");
    try {
      progress.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  playBtn.addEventListener("click", togglePlay);
  centerPlay.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  videoWrap.addEventListener("dblclick", toggleFullscreen);
  backBtn.addEventListener("click", skipBack);
  fwdBtn.addEventListener("click", skipFwd);
  muteBtn.addEventListener("click", () => (video.muted = !video.muted));
  volumeSlider.addEventListener("input", () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
  });
  speedSelect.addEventListener("change", () => {
    video.playbackRate = parseFloat(speedSelect.value);
  });
  if (document.pictureInPictureEnabled) {
    pipBtn.addEventListener("click", () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else video.requestPictureInPicture().catch(() => {});
    });
  } else pipBtn.style.display = "none";
  fsBtn.addEventListener("click", toggleFullscreen);

  video.addEventListener("play", updatePlayIcon);
  video.addEventListener("pause", updatePlayIcon);
  video.addEventListener("ended", updatePlayIcon);
  video.addEventListener("volumechange", updateVolumeIcon);
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("progress", updateProgress);
  video.addEventListener("loadedmetadata", () => {
    updateProgress();
    if (video._pendingSeek) {
      video.currentTime = video._pendingSeek;
      video._pendingSeek = 0;
    }
  });

  /* The exact resolution being decoded right now. For MP4 that is the encoded
     frame size (which can differ from the nominal "480p"); for DASH it follows
     the ABR rendition, so it changes as the stream adapts. */
  const resTag = $("#mt-res-tag");
  function updateResTag() {
    if (!resTag) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    resTag.textContent = w && h ? `${w}×${h}` : "";
  }
  video.addEventListener("resize", updateResTag);
  video.addEventListener("loadedmetadata", updateResTag);
  video.addEventListener("playing", updateResTag);
  updateResTag();
  updatePlayIcon();
  updateVolumeIcon();

  let hideTimer = null;
  function showChrome() {
    topbarEl.classList.remove("mt-hidden");
    controlsEl.classList.remove("mt-hidden");
    overlay.style.cursor = "";
    clearTimeout(hideTimer);
    if (!video.paused) hideTimer = setTimeout(hideChrome, 2800);
  }
  function hideChrome() {
    if (video.paused || dragging) return;
    topbarEl.classList.add("mt-hidden");
    controlsEl.classList.add("mt-hidden");
    overlay.style.cursor = "none";
  }
  overlay.addEventListener("mousemove", showChrome);
  overlay.addEventListener("mouseleave", () => {
    if (!video.paused) hideChrome();
  });
  showChrome();

  /* ── subtitles ── */
  let subTrackBlobs = [];
  let cueHandler = null;

  function clearSubtitle() {
    const old = video.querySelector("track[data-mt-subtitle]");
    if (old) old.remove();
    subTrackBlobs.forEach((b) => {
      try {
        URL.revokeObjectURL(b);
      } catch {
        /* ignore */
      }
    });
    subTrackBlobs = [];
    const ov = $("#mt-subtitle-overlay");
    if (ov) {
      ov.innerHTML = "";
      ov.classList.remove("mt-dual");
    }
  }

  function renderCues(cues) {
    const ov = $("#mt-subtitle-overlay");
    if (!ov) return;
    if (!cues || !cues.length) {
      ov.innerHTML = "";
      return;
    }
    const active = (sub.primary ? 1 : 0) + (sub.secondary ? 1 : 0);
    if (active > 0 && cues.length > active) cues.splice(0, cues.length, ...cues.slice(0, active));
    ov.innerHTML = cues
      .map((c) =>
        c.text
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => '<div class="mt-subtitle-line">' + esc(l.replace(/<[^>]+>/g, "")) + "</div>")
          .join("")
      )
      .join("");
  }

  async function applySubtitles() {
    clearSubtitle();
    const ov = $("#mt-subtitle-overlay");
    if (!ov || (!sub.primary && !sub.secondary)) return;
    if (sub.secondary) ov.classList.add("mt-dual");
    else ov.classList.remove("mt-dual");
    const urls = [sub.primary?.url, sub.secondary?.url].filter(Boolean);
    const texts = await Promise.all(urls.map((u) => fetchSubtitle(u).catch(() => "")));
    let vtt = "";
    if (texts.length === 2 && texts[0] && texts[1]) vtt = mergeDual(texts[0], texts[1]);
    else if (texts[0]) vtt = texts[0];
    if (!vtt) return;
    const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    subTrackBlobs.push(blobUrl);
    const track = document.createElement("track");
    track.setAttribute("data-mt-subtitle", "");
    track.kind = "metadata";
    track.src = blobUrl;
    track.label = sub.primary ? sub.primary.lanName : "subtitles";
    video.appendChild(track);
    if (cueHandler) video.removeEventListener("cuechange", cueHandler);
    const textTrack = track.track;
    textTrack.mode = "hidden";
    cueHandler = () => renderCues(textTrack.activeCues ? Array.from(textTrack.activeCues) : []);
    textTrack.addEventListener("cuechange", cueHandler);
    if (!video.paused) setTimeout(() => textTrack.dispatchEvent(new Event("cuechange")), 120);
  }

  function buildSubtitleSelects() {
    const s1 = $("#mt-subtitle-select");
    const s2 = $("#mt-dual-subtitle-select");
    s1.innerHTML = '<option value="">Subs: Off</option>';
    s2.innerHTML = '<option value="">Subs2: Off</option>';
    sub.captions.forEach((c) => {
      for (const s of [s1, s2]) {
        const o = document.createElement("option");
        o.value = c.lanName;
        o.textContent = c.lanName;
        s.appendChild(o);
      }
    });
    if (sub.primary) s1.value = sub.primary.lanName;
    if (sub.secondary) s2.value = sub.secondary.lanName;
  }

  $("#mt-subtitle-select").addEventListener("change", (e) => {
    sub.primary = sub.captions.find((c) => c.lanName === e.target.value) || null;
    applySubtitles();
  });
  $("#mt-dual-subtitle-select").addEventListener("change", (e) => {
    const found = sub.captions.find((c) => c.lanName === e.target.value) || null;
    sub.secondary = found && found.lanName !== sub.primary?.lanName ? found : null;
    e.target.value = sub.secondary ? sub.secondary.lanName : "";
    applySubtitles();
  });

  async function loadCaptions() {
    try {
      const pick = playData.hls?.[0] || playData.streams?.[0] || playData.dash?.[0];
      if (!pick || !opts.getCaptions) return;
      const format = playData.hls?.[0] ? "HLS" : "MP4";
      const captions = await opts.getCaptions({
        format,
        id: pick.id,
        subjectId: meta.subjectId,
        detailPath: meta.detailPath,
      });
      if (!captions?.length) return;
      sub.captions = captions;
      buildSubtitleSelects();
      // auto-select user's preferred language
      const pref = (navigator.language || "en").split("-")[0];
      const auto = captions.find((c) => getLangCode(c.lanName) === pref) || null;
      if (auto) {
        sub.primary = auto;
        $("#mt-subtitle-select").value = auto.lanName;
        applySubtitles();
      }
    } catch {
      /* captions are optional */
    }
  }

  /* ── episodes ── */
  function buildEpisodes() {
    if (!isSeries) return;
    const tabs = $("#mt-season-tabs");
    const grid = $("#mt-ep-grid");
    if (!tabs || !grid || !meta.seasons.length) return;
    let seasonIdx = Math.max(0, meta.seasons.findIndex((s) => s.se === meta.curSe));
    if (meta.seasons.length > 1) {
      tabs.innerHTML = "";
      meta.seasons.forEach((s, i) => {
        const b = document.createElement("button");
        b.textContent = s.se;
        b.className = "mt-season-tab" + (i === seasonIdx ? " mt-active" : "");
        b.addEventListener("click", () => {
          tabs.querySelectorAll("button").forEach((t, j) => t.classList.toggle("mt-active", j === i));
          renderGrid(i);
        });
        tabs.appendChild(b);
      });
    }
    function renderGrid(idx) {
      const season = meta.seasons[idx];
      if (!season) return;
      grid.innerHTML = "";
      epList(season).forEach((ep) => {
        const b = document.createElement("button");
        b.textContent = ep;
        b.className = "mt-ep-cell" + (meta.curSe === season.se && meta.curEp === ep ? " mt-active" : "");
        b.addEventListener("click", () => switchToEpisode(season.se, ep));
        grid.appendChild(b);
      });
    }
    renderGrid(seasonIdx);
  }

  function updateEpBadge() {
    const badge = $("#mt-ep-badge");
    if (badge && meta.curSe && meta.curEp) badge.textContent = `S${meta.curSe} · E${meta.curEp}`;
    const grid = $("#mt-ep-grid");
    if (grid)
      grid.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("mt-active", meta.curEp === parseInt(b.textContent, 10))
      );
  }

  async function switchToEpisode(se, ep) {
    meta.curSe = se;
    meta.curEp = ep;
    updateEpBadge();
    errorEl.style.display = "none";
    showLoading(`Loading episode ${ep}…`);
    try {
      const data = await opts.getPlayData(se, ep);
      if (data && (data.streams?.length || data.hls?.length || data.dash?.length)) {
        playData = data;
        const parsed = sourcesFrom(data);
        qualityOptions(parsed.sources);
        currentIdx = defaultIndex();
        sel.value = currentIdx;
        statusEl.textContent = parsed.type;
        loadSource(currentIdx);
        loadCaptions();
      } else {
        hideLoading();
        errorEl.textContent = "No sources for this episode.";
        errorEl.style.display = "block";
      }
    } catch (err) {
      hideLoading();
      errorEl.textContent = "Failed to load episode: " + err.message;
      errorEl.style.display = "block";
    }
  }

  /* ── settings sheet ── */
  const epPanel = $("#mt-ep-panel");
  function setSettings(open) {
    settingsPanel.classList.toggle("mt-open", open);
  }
  $("#mt-settings-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setSettings(!settingsPanel.classList.contains("mt-open"));
  });
  $("#mt-settings-close")?.addEventListener("click", () => setSettings(false));
  overlay.addEventListener("click", (e) => {
    if (!settingsPanel.classList.contains("mt-open")) return;
    if (settingsPanel.contains(e.target) || e.target.closest("#mt-settings-btn")) return;
    setSettings(false);
  });

  if (isSeries) {
    buildEpisodes();
    $("#mt-toggle-ep")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setSettings(false);
      epPanel.classList.toggle("mt-open");
    });
    $("#mt-close-ep")?.addEventListener("click", () => epPanel.classList.remove("mt-open"));
  }

  /* ── close + keys ── */
  function close() {
    clearInterval(healthWatch);
    document.body.classList.remove("mt-playing");
    saveProgress(video.currentTime);
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (hls) hls.destroy();
    if (dash) dash.reset();
    document.removeEventListener("keydown", onKey);
    subTrackBlobs.forEach((b) => {
      try {
        URL.revokeObjectURL(b);
      } catch {
        /* ignore */
      }
    });
    overlay.classList.add("mt-closing");
    setTimeout(() => overlay.remove(), 150);
    opts.onClose?.();
  }
  overlay.querySelector("#mt-close-btn").addEventListener("click", close);

  function onKey(e) {
    if (e.key === "Escape") {
      if (settingsPanel.classList.contains("mt-open")) return setSettings(false);
      if (epPanel && epPanel.classList.contains("mt-open")) return epPanel.classList.remove("mt-open");
      return close();
    }
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === " " || e.key === "k" || e.key === "K") {
      e.preventDefault();
      togglePlay();
      showChrome();
    } else if (e.key === "ArrowRight") skipFwd(), showChrome();
    else if (e.key === "ArrowLeft") skipBack(), showChrome();
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      showChrome();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      showChrome();
    } else if (e.key === "m" || e.key === "M") (video.muted = !video.muted), showChrome();
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else if (e.key === "c" || e.key === "C") {
      const s = $("#mt-subtitle-select");
      s.selectedIndex = (s.selectedIndex + 1) % s.options.length;
      s.dispatchEvent(new Event("change"));
    }
  }
  document.addEventListener("keydown", onKey);

  video.addEventListener("loadedmetadata", () => {
    clearSubtitle();
    if (sub.captions.length) setTimeout(applySubtitles, 300);
  });

  loadCaptions();

  return { close };
}
