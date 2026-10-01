// notmoviebox — frontend application (hash router + views + auth).

import {
  api,
  bridgeApi,
  mediaUrl,
  isLoggedIn,
  getUser,
  setUser,
  setUserToken,
  getUserToken,
  IMG,
  img,
  subjectYear,
} from "./api.js?v=9";
import { openPlayer } from "./player.js?v=9";

/* ══ config ═══════════════════════════════════════════════════════════════ */

const HOST = "themoviebox.xyz";

const NAV = [
  { key: "home", label: "Home", href: "#/" },
  { key: "movie", label: "Movies", href: "#/channel/1" },
  { key: "tv", label: "TV Shows", href: "#/channel/2" },
  { key: "anime", label: "Anime", href: "#/channel/4" },
  { key: "midnight", label: "Midnight", href: "#/browse/ONEROOM_MIDNIGHT" },
  { key: "ranking", label: "Top 100", href: "#/ranking/6139355499743139400" },
];

const CHANNELS = {
  1: { title: "Movies", subjectType: 1 },
  2: { title: "TV Shows", subjectType: 2 },
  4: { title: "Anime", subjectType: 4 },
};

const RANKING_MENUS = [
  { name: "TOP Movies", id: "6139355499743139400" },
  { name: "Cinema", id: "5692654647815587592" },
  { name: "New Punjabi", id: "6027735606879570952" },
  { name: "Bollywood", id: "414907768299210008" },
  { name: "Hollywood", id: "8019599703232971616" },
  { name: "South Indian", id: "3859721901924910512" },
  { name: "New Release", id: "1488104699998914056" },
];

const GENRES = [
  "All", "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime",
  "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Kids",
  "Music", "Mystery", "Reality", "Romance", "Sci-Fi", "Sport", "Thriller",
  "War", "Western",
];
const SORTS = [
  { id: "ForYou", label: "For You" },
  { id: "Latest", label: "Latest" },
  { id: "Rating", label: "Top Rated" },
];
const YEARS = ["All", ...Array.from({ length: 27 }, (_, i) => String(2026 - i))];
const CLASSIFY = [
  "All", "Hindi dub", "Punjabi dub", "English", "Bengali dub", "Tamil dub",
  "Telugu dub", "Malayalam dub", "Kannada dub", "Marathi dub", "Urdu dub",
];

/* ══ tiny DOM helpers ═════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.innerHTML = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/* ══ progress bar ═════════════════════════════════════════════════════════ */

const app = $("#app");
let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

function runCleanups() {
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  cleanups = [];
}

function mount(...nodes) {
  app.innerHTML = "";
  app.append(...nodes);
  window.scrollTo({ top: 0 });
  app.focus({ preventScroll: true });
}

function loadingBlock() {
  return el("div", { class: "loading-block" }, el("div", { class: "spinner" }), el("div", { text: "Loading…" }));
}
function emptyBlock(msg) {
  return el("div", { class: "empty-block", text: msg || "Nothing here yet." });
}

/* ══ cards ════════════════════════════════════════════════════════════════ */

function card(s) {
  const year = subjectYear(s);
  const poster = img(IMG.cover(s), 320);
  return el(
    "a",
    { class: "card", href: `#/title/${encodeURIComponent(s.detailPath)}` },
    el(
      "div",
      { class: "card-poster" },
      poster
        ? el("img", { src: poster, alt: s.title, loading: "lazy", decoding: "async" })
        : el("div", { class: "skeleton", style: "width:100%;height:100%" }),
      s.corner ? el("span", { class: "card-badge", text: s.corner }) : null,
      s.imdbRatingValue ? el("span", { class: "card-rating", text: s.imdbRatingValue }) : null
    ),
    el("div", { class: "card-title", text: s.title }),
    el("div", { class: "card-sub", text: [year, s.countryName].filter(Boolean).join(" · ") })
  );
}

function cardRow(title, subjects, moreHref) {
  if (!subjects?.length) return null;
  return el(
    "section",
    { class: "row" },
    el(
      "div",
      { class: "row-head" },
      el("h2", { class: "row-title", text: title }),
      moreHref ? el("a", { class: "row-more", href: moreHref, text: "View all ›" }) : null
    ),
    el("div", { class: "scroller" }, subjects.map(card))
  );
}

/* ══ infinite grid ════════════════════════════════════════════════════════ */

function makeGrid(fetchPage, { columns } = {}) {
  const grid = el("div", { class: "grid" });
  const sentinel = el("div", { class: "sentinel" });
  const status = el("div", { class: "loading-block", style: "padding:28px" }, el("div", { class: "spinner" }));
  const wrap = el("div", {}, grid, status, sentinel);

  let page = 0;
  let done = false;
  let busy = false;

  async function load() {
    if (busy || done) return;
    busy = true;
    status.style.display = "block";
    try {
      const res = await fetchPage(page + 1);
      const items = res.items || res.subjectList || [];
      const pager = res.pager || {};
      page = Number(pager.page || page + 1);
      items.forEach((s) => grid.append(card(s)));
      if (!items.length) {
        done = true;
        if (page <= 1) grid.append(emptyBlock("No results."));
      }
      if (pager.hasMore === false || (!items.length && page > 1)) done = true;
    } catch (err) {
      done = true;
      grid.append(emptyBlock("Failed to load: " + esc(err.message)));
    } finally {
      busy = false;
      status.style.display = "none";
      if (done) io.disconnect();
    }
  }

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) load();
  }, { rootMargin: "600px 0px" });
  io.observe(sentinel);
  onCleanup(() => io.disconnect());

  load();
  return wrap;
}

/* ══ views ════════════════════════════════════════════════════════════════ */

async function viewHome() {
  mount(loadingBlock());
  try {
    const data = await api.home(HOST);
    const sections = data.operatingList || [];
    const banner = sections.find((s) => s.type === "BANNER" && s.banner?.items?.length);
    const rows = sections.filter((s) => s.subjects?.length);
    const filters = sections.find((s) => s.type === "FILTER");

    const nodes = [];
    if (banner) nodes.push(hero(banner.banner.items));
    if (filters?.filters?.length) nodes.push(filterStrip(filters.filters));
    for (const s of rows) nodes.push(cardRow(s.title, s.subjects, moreHrefFor(s)));
    if (!nodes.length) nodes.push(emptyBlock("No content."));
    mount(...nodes);
  } catch (err) {
    mount(emptyBlock("Failed to load home: " + esc(err.message)));
  }
}

function moreHrefFor(section) {
  // Home/tab rows carry a genreTopId that expands to the full list via
  // /ranking-list/content (the same endpoint the site's own "more" uses).
  if (!section.genreTopId) return null;
  const q = section.title ? `?title=${encodeURIComponent(section.title)}` : "";
  return `#/collection/${section.genreTopId}${q}`;
}

function filterStrip(filters) {
  return el(
    "section",
    { class: "row" },
    el("div", { class: "row-head" }, el("h2", { class: "row-title", text: "Browse categories" })),
    el("div", { class: "chips" }, filters.slice(0, 24).map((f) => {
      const target = categoryTargetFromQuery(f.query);
      return el("a", { class: "chip", href: target, text: f.title });
    }))
  );
}

function categoryTargetFromQuery(query) {
  try {
    const q = new URLSearchParams(query || "");
    const ft = JSON.parse(q.get("filterType") || "{}");
    const channel = ft.country === "Pakistan" ? 1 : 1;
    const params = new URLSearchParams();
    if (ft.genre && ft.genre !== "All") params.set("genre", ft.genre);
    if (ft.classify && ft.classify !== "All") params.set("classify", ft.classify);
    return `#/channel/${channel}?${params.toString()}`;
  } catch {
    return "#/channel/1";
  }
}

function hero(items) {
  const root = el("section", { class: "hero" });
  const bg = el("div", { class: "hero-bg" });
  const content = el("div", { class: "hero-content" });
  const dots = el("div", { class: "hero-dots" });
  root.append(bg, content, dots);

  let idx = 0;
  let timer = null;

  function render(i) {
    idx = (i + items.length) % items.length;
    const item = items[idx];
    const subject = item.subject || {};
    const detailPath = subject.detailPath || item.detailPath;
    const href = detailPath ? `#/title/${encodeURIComponent(detailPath)}` : null;
    bg.innerHTML = "";
    const backdrop = IMG.still({ stills: { url: item.image?.url }, cover: subject.cover });
    if (backdrop) bg.append(el("img", { src: img(backdrop, 1600, 75), alt: "", decoding: "async" }));

    content.innerHTML = "";
    content.append(
      el("div", { class: "hero-kicker", text: item.subjectType === 2 || subject.subjectType === 2 ? "Featured series" : "Featured" }),
      el("h1", { class: "hero-title", text: subject.title || item.title || "Untitled" }),
      el(
        "div",
        { class: "hero-meta" },
        subject.releaseDate ? el("span", { text: (subject.releaseDate || "").slice(0, 4) }) : null,
        subject.imdbRatingValue ? el("span", { text: "★ " + subject.imdbRatingValue }) : null,
        subject.countryName ? el("span", { text: subject.countryName }) : null,
        subject.genre ? el("span", { text: subject.genre.split(",").slice(0, 3).join(" · ") }) : null
      ),
      subject.description ? el("div", { class: "hero-overview", text: subject.description }) : null,
      el(
        "div",
        { class: "hero-actions" },
        href ? el("a", { class: "btn btn-primary", href }, "▶ Play") : null,
        href ? el("a", { class: "btn btn-ghost", href }, "More info") : null
      )
    );

    dots.querySelectorAll(".hero-dot").forEach((d, j) => d.classList.toggle("active", j === idx));
  }

  items.forEach((_, i) => {
    dots.append(el("button", { class: "hero-dot", "aria-label": "Slide " + (i + 1), onclick: () => { render(i); restart(); } }));
  });

  function restart() {
    clearInterval(timer);
    timer = setInterval(() => render(idx + 1), 7000);
  }
  render(0);
  restart();
  onCleanup(() => clearInterval(timer));
  return root;
}

async function viewChannel(channelId, params) {
  const conf = CHANNELS[channelId] || { title: "Browse" };
  const state = {
    genre: params.get("genre") || "All",
    sort: params.get("sort") || "ForYou",
    year: params.get("year") || "All",
    classify: params.get("classify") || "All",
  };

  const head = el("div", { class: "page-head" }, el("h1", { class: "page-title", text: conf.title }));
  const chipWrap = el("div", { class: "chips" });
  const sortSel = sel(SORTS.map((s) => [s.id, s.label]), state.sort);
  const yearSel = sel(YEARS.map((y) => [y, y === "All" ? "Any year" : y]), state.year);
  const classifySel = sel(CLASSIFY.map((c) => [c, c === "All" ? "All languages" : c]), state.classify);

  const bar = el(
    "div",
    { class: "filterbar" },
    chipWrap,
    el("div", { class: "field" }, el("label", { text: "Sort" }), sortSel),
    el("div", { class: "field" }, el("label", { text: "Year" }), yearSel),
    el("div", { class: "field" }, el("label", { text: "Lang" }), classifySel)
  );

  const gridHost = el("div");

  function paintChips() {
    chipWrap.innerHTML = "";
    for (const g of GENRES) {
      chipWrap.append(
        el("button", {
          class: "chip" + (g === state.genre ? " active" : ""),
          text: g,
          onclick: () => {
            state.genre = g;
            paintChips();
            rebuild();
          },
        })
      );
    }
  }

  function rebuild() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v && v !== "All") qs.set(k, v);
    history.replaceState(null, "", `#/channel/${channelId}${qs.toString() ? "?" + qs : ""}`);
    gridHost.innerHTML = "";
    gridHost.append(
      makeGrid((page) =>
        api.filter({
          page,
          perPage: 36,
          channelId: Number(channelId),
          genre: state.genre !== "All" ? state.genre : undefined,
          sort: state.sort || undefined,
          year: state.year !== "All" ? state.year : undefined,
          classify: state.classify !== "All" ? state.classify : undefined,
        })
      )
    );
  }

  sortSel.addEventListener("change", () => { state.sort = sortSel.value; rebuild(); });
  yearSel.addEventListener("change", () => { state.year = yearSel.value; rebuild(); });
  classifySel.addEventListener("change", () => { state.classify = classifySel.value; rebuild(); });

  paintChips();
  mount(head, bar, gridHost);
  rebuild();
}

function sel(options, value) {
  const s = el("select", { class: "select" });
  for (const [v, label] of options) s.append(el("option", { value: v, selected: v === value, text: label }));
  return s;
}

async function viewBrowse(tabId) {
  mount(loadingBlock());
  try {
    const data = await api.tabOperating(tabId, HOST);
    const sections = data.operatingList || [];
    const rows = sections.filter((s) => s.subjects?.length);
    const heroSection = sections.find((s) => s.type === "BANNER" && s.banner?.items?.length);
    const title = tabId === "ONEROOM_MIDNIGHT" ? "Midnight" : tabId === "ONEROOM_HOME" ? "Home" : "Browse";

    const nodes = [el("div", { class: "page-head" }, el("h1", { class: "page-title", text: title }))];
    if (heroSection) nodes.push(hero(heroSection.banner.items));
    rows.forEach((s) => nodes.push(cardRow(s.title, s.subjects, moreHrefFor(s))));
    nodes.push(
      el("section", { class: "row" },
        el("div", { class: "row-head" }, el("h2", { class: "row-title", text: "All titles" })),
        makeGrid((page) => api.trending(tabId, page, 36))
      )
    );
    mount(...nodes);
  } catch (err) {
    mount(emptyBlock("Failed to load: " + esc(err.message)));
  }
}

async function viewRanking(id) {
  const menu = RANKING_MENUS.find((m) => m.id === id) || RANKING_MENUS[0];
  const tabs = el("div", { class: "chips" });
  for (const m of RANKING_MENUS) {
    tabs.append(el("a", { class: "chip" + (m.id === menu.id ? " active" : ""), href: `#/ranking/${m.id}`, text: m.name }));
  }
  const head = el("div", { class: "page-head" }, el("h1", { class: "page-title", text: "Most watched" }), el("p", { class: "page-sub", text: menu.name }));
  mount(head, el("div", { class: "filterbar" }, tabs), makeGrid((page) => api.ranking(menu.id, page, 40)));
}

/** "View all" for a home/tab row: the full paginated list behind its genreTopId. */
async function viewCollection(genreTopId, params) {
  const title = params.get("title") || "Collection";
  const head = el(
    "div",
    { class: "page-head" },
    el("h1", { class: "page-title", text: title }),
    el("p", { class: "page-sub", text: "All titles in this list" })
  );
  mount(head, makeGrid((page) => api.ranking(genreTopId, page, 40)));
}

async function viewSearch(q) {
  const head = el("div", { class: "page-head" }, el("h1", { class: "page-title", text: q ? `Results for “${q}”` : "Search" }));
  const host = el("div");

  if (!q) {
    mount(head, host);
    try {
      const data = await api.everyoneSearch();
      const words = data.everyoneSearch || [];
      host.append(
        el("div", { class: "filterbar" },
          el("div", { class: "chips" }, words.map((w) =>
            el("a", { class: "chip", href: `#/search/${encodeURIComponent(w.title)}`, text: w.title })
          ))
        )
      );
    } catch {
      host.append(emptyBlock("Type a title above to search."));
    }
    return;
  }

  mount(head, host);
  host.append(makeGrid((page) => api.search({ keyword: q, page, perPage: 36 })));
}

async function viewDetail(detailPath) {
  mount(loadingBlock());
  let data;
  try {
    data = await api.detail(detailPath);
  } catch (err) {
    mount(emptyBlock("Failed to load title: " + esc(err.message)));
    return;
  }

  const subject = data.subject || {};
  const resource = data.resource || {};
  const seasons = (resource.seasons || []).map((s) => ({
    se: s.se,
    maxEp: s.maxEp || 0,
    allEp: s.allEp || "",
  }));
  const isSeries = subject.subjectType === 2 && seasons.length > 0;
  const ctx = { subjectId: subject.subjectId, detailPath: subject.detailPath || detailPath, subjectType: subject.subjectType, title: subject.title, seasons };

  const backdrop = img(IMG.still({ stills: subject.stills, cover: subject.cover }) || IMG.cover(subject), 1600, 75);

  const detail = el(
    "section",
    { class: "detail-hero" },
    el("div", { class: "detail-bg" }, backdrop ? el("img", { src: backdrop, alt: "", decoding: "async" }) : null),
    el(
      "div",
      { class: "detail-content" },
      el(
        "div",
        { class: "detail-poster" },
        IMG.cover(subject)
          ? el("img", { src: img(IMG.cover(subject), 400), alt: subject.title, decoding: "async" })
          : null
      ),
      el(
        "div",
        { class: "detail-info" },
        el("h1", { class: "detail-title", text: subject.title }),
        el(
          "div",
          { class: "detail-meta" },
          subject.releaseDate ? el("span", { class: "pill", text: (subject.releaseDate || "").slice(0, 4) }) : null,
          subject.imdbRatingValue ? el("span", { class: "pill", text: "★ " + subject.imdbRatingValue }) : null,
          isSeries ? el("span", { class: "pill", text: seasons.length + " season" + (seasons.length > 1 ? "s" : "") }) : el("span", { class: "pill", text: "Movie" }),
          subject.countryName ? el("span", { class: "pill", text: subject.countryName }) : null,
          subject.accessStrategy ? el("span", { class: "pill", text: "VIP" }) : subject.hasResource ? el("span", { class: "pill", text: "Free" }) : null
        ),
        subject.genre
          ? el("div", { class: "detail-genres" }, subject.genre.split(",").map((g) =>
              el("a", { href: `#/channel/1?genre=${encodeURIComponent(g.trim())}`, text: g.trim() })
            ))
          : null,
        subject.description ? el("p", { class: "detail-overview", text: subject.description }) : null,
        el(
          "div",
          { class: "detail-actions" },
          el("button", {
            class: "btn btn-primary",
            onclick: () => startPlay(ctx, isSeries ? seasons[0].se : 0, isSeries ? 1 : 0),
          }, "▶ Play"),
          subject.trailer?.videoAddress?.url
            ? el("button", {
                class: "btn btn-ghost",
                onclick: () => playTrailer(subject),
              }, "Trailer")
            : null
        )
      )
    )
  );

  const nodes = [detail];

  if (isSeries) {
    let activeSeason = seasons[0];
    const tabs = el("div", { class: "season-tabs" });
    const list = el("div", { class: "ep-list" });
    const block = el(
      "section",
      { class: "ep-block" },
      el("div", { class: "ep-block-head" }, el("h2", { text: "Episodes" }), tabs),
      list
    );

    const saved = readProgress(subject.subjectId);
    const resume = saved && seasons.some((s) => s.se === saved.se) ? saved : null;

    function paintEpisodes(season) {
      activeSeason = season;
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.se) === season.se));
      list.innerHTML = "";
      const eps = season.allEp ? season.allEp.split(",").map(Number) : Array.from({ length: season.maxEp }, (_, i) => i + 1);
      for (const ep of eps) {
        list.append(el("button", {
          class: "ep-item" + (resume && resume.se === season.se && resume.ep === ep ? " active" : ""),
          text: ep,
          onclick: () => startPlay(ctx, season.se, ep),
        }));
      }
    }

    seasons.forEach((s) => {
      tabs.append(el("button", { class: "season-tab", dataset: { se: s.se }, text: "Season " + s.se, onclick: () => paintEpisodes(s) }));
    });
    paintEpisodes(resume ? seasons.find((s) => s.se === resume.se) : seasons[0]);
    nodes.push(block);
  }

  mount(...nodes);

  // related
  try {
    const rec = await api.detailRec(subject.subjectId, 1, 14);
    const items = rec.items || [];
    if (items.length) app.append(cardRow("More like this", items));
  } catch {
    /* optional */
  }
}

function readProgress(subjectId) {
  try {
    return JSON.parse(localStorage.getItem("nmb_progress_" + subjectId) || "null");
  } catch {
    return null;
  }
}

function hasSources(data) {
  // Play anything the API returned with a URL — including renditions marked
  // `vipLocked`, as long as the API also handed over the URL + signed header.
  const any = (arr) => (arr || []).some((s) => s.url);
  return !!(data && (any(data.streams) || any(data.hls) || any(data.dash)));
}

async function startPlay(ctx, se, ep) {
  toast("Loading stream…", 2000);
  let data;
  try {
    data = await api.play({ subjectId: ctx.subjectId, se, ep, detailPath: ctx.detailPath });
  } catch (err) {
    toast("Playback failed: " + esc(err.message));
    return;
  }
  if (!hasSources(data)) {
    toast("No video links were returned for this title.", 5000);
    return;
  }
  openPlayer({
    data,
    meta: { ...ctx, curSe: se, curEp: ep },
    getPlayData: (s, e) => api.play({ subjectId: ctx.subjectId, se: s, ep: e, detailPath: ctx.detailPath }),
    getCaptions: async ({ format, id }) => {
      const d = await api.caption({ format, id, subjectId: ctx.subjectId, detailPath: ctx.detailPath });
      return d.captions || [];
    },
  });
}

function playTrailer(subject) {
  const url = subject.trailer?.videoAddress?.url;
  if (!url) return;
  openPlayer({
    data: {
      streams: [{ resolutions: subject.trailer.videoAddress.height || 720, url, id: "trailer" }],
      hls: [],
      dash: [],
    },
    meta: { subjectId: null, subjectType: 1, title: subject.title + " — Trailer", detailPath: "", seasons: [] },
    getPlayData: async () => ({}),
    getCaptions: async () => [],
  });
}

/* ══ auth ═════════════════════════════════════════════════════════════════ */

const FIREBASE = {
  apiKey: "AIzaSyC7363hLA2A6Udh-iz0ybG5ng6FUiu4_aM",
  authDomain: "mb-seo-f9b99.firebaseapp.com",
  projectId: "mb-seo-f9b99",
  storageBucket: "mb-seo-f9b99.firebasestorage.app",
  messagingSenderId: "854587335712",
  appId: "1:854587335712:web:da0ea605801a7998114845",
};
const GOOGLE_CLIENT_ID = "854587335712-armrb6l39evf3c685m0h9smj4gmlv09r.apps.googleusercontent.com";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

async function finishLogin(token) {
  setUserToken(token);
  try {
    const me = await api.profile();
    setUser(me);
  } catch {
    /* profile is optional */
  }
  reflectAccount();
  toast("Signed in ✓");
}

async function googleSignIn() {
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
  const fb = window.firebase;
  if (!fb.apps.length) fb.initializeApp(FIREBASE);
  const provider = new fb.auth.GoogleAuthProvider();
  provider.setCustomParameters({ client_id: GOOGLE_CLIENT_ID, prompt: "select_account" });
  const result = await fb.auth().signInWithPopup(provider);
  const cred = fb.auth.GoogleAuthProvider.credentialFromResult(result);
  const idToken = cred?.idToken;
  const accessToken = cred?.accessToken;
  if (!idToken) throw new Error("Google credential missing token");
  const data = await api.googleLogin({ idToken, accessToken });
  const token = typeof data === "string" ? data : data?.token;
  if (!token) throw new Error("Login did not return a token");
  await finishLogin(token);
}

function openLogin() {
  const root = $("#modal-root");
  root.innerHTML = "";
  const body = el("div", { class: "modal-body" });
  const status = el("div", { class: "qr-status", text: "Free playback works without an account. Sign in for HD / VIP titles." });

  const close = () => {
    clearInterval(pollTimer);
    clearInterval(bridgePoll);
    root.innerHTML = "";
  };

  /* ── 1. browser bridge ─────────────────────────────────────────────────── */
  const bridgeNote = el("div", { class: "opt-note", text: "Play through your own signed-in Chrome session. Opens a browser window — sign in there once." });
  const bridgeBtn = el("button", { class: "btn btn-primary opt-btn" }, "Open browser & sign in");
  bridgeBtn.addEventListener("click", async () => {
    bridgeBtn.disabled = true;
    bridgeNote.textContent = "Starting browser…";
    try {
      await bridgeApi.start();
      bridgeNote.textContent = "Sign in to MovieBox in the window that opened. This dialog updates automatically.";
      startBridgePoll();
    } catch (err) {
      bridgeNote.textContent = "Could not start a browser: " + (err.message || err) + " (set NMB_CHROME to a Chrome path)";
    } finally {
      bridgeBtn.disabled = false;
    }
  });

  let bridgePoll = null;
  function startBridgePoll() {
    clearInterval(bridgePoll);
    bridgePoll = setInterval(async () => {
      const s = await bridgeApi.session().catch(() => null);
      if (s?.loggedIn) {
        clearInterval(bridgePoll);
        setBridgeState(s);
        reflectAccount();
        toast("Signed in via browser session ✓");
        close();
      }
    }, 2500);
  }

  /* ── 2. paste a session token ──────────────────────────────────────────── */
  const tokenInput = el("input", { class: "opt-input", type: "text", placeholder: "Paste your MovieBox session token" });
  const tokenBtn = el("button", { class: "btn opt-btn" }, "Use token");
  const bookmarklet =
    "javascript:(async()=>{const r=await fetch('/wefeed-h5api-bff/user/profile',{headers:{Accept:'application/json'}});const t=JSON.parse(r.headers.get('x-user')||'{}').token;if(t){await navigator.clipboard.writeText(t);alert('Session token copied — paste it into notmoviebox.')}else{alert('Not signed in on this page.')}})()";
  const blLink = el("a", { class: "opt-link", href: bookmarklet, title: "Drag me to your bookmarks bar" }, "get token from themoviebox.xyz →");

  tokenBtn.addEventListener("click", async () => {
    const t = tokenInput.value.trim();
    if (!t) return;
    setUserToken(t);
    try {
      await api.profile();
      reflectAccount();
      toast("Signed in ✓");
      close();
    } catch {
      setUserToken("");
      toast("That token did not work.");
    }
  });

  /* ── 3. Google + QR ────────────────────────────────────────────────────── */
  const googleBtn = el("button", { class: "oauth-btn" },
    el("img", { src: "https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg", alt: "" }),
    "Continue with Google"
  );
  googleBtn.addEventListener("click", async () => {
    status.textContent = "Opening Google…";
    try {
      await googleSignIn();
      close();
    } catch (err) {
      status.textContent = "Google sign-in failed: " + err.message;
    }
  });

  const qrBox = el("div", { class: "qr-box" });
  let qrTicket = null;
  let pollTimer = null;

  async function startQr() {
    try {
      const t = await api.qrCreate();
      qrTicket = t.ticket;
      qrBox.innerHTML = "";
      qrBox.append(
        el("img", { src: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(t.qrUrl || t.ticket)}`, alt: "QR code" }),
        el("div", { class: "qr-status", text: "Scan with the MovieBox mobile app" })
      );
      let last = "WAITING";
      pollTimer = setInterval(async () => {
        try {
          const s = await api.qrPoll({ ticket: qrTicket, lastStatus: last });
          last = s.status;
          if (s.status === "SCANNED") $(".qr-status", qrBox).textContent = "Scanned — confirm on your phone…";
          if (s.status === "CONFIRMED") {
            clearInterval(pollTimer);
            const f = await api.qrFetch({ ticket: qrTicket });
            const token = typeof f === "string" ? f : f?.token;
            if (token) {
              await finishLogin(token);
              close();
            } else status.textContent = "Could not fetch token.";
          }
          if (["EXPIRED", "CANCELED", "CONSUMED"].includes(s.status)) {
            clearInterval(pollTimer);
            $(".qr-status", qrBox).textContent = "QR expired — reopen the dialog to retry";
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (err) {
      status.textContent = "QR login unavailable: " + err.message;
    }
  }

  const bridgeBlock = el("div", { class: "opt" },
    el("div", { class: "opt-title", text: "Browser session" }),
    bridgeNote,
    bridgeBtn
  );
  const bridgeDivider = el("div", { class: "divider", text: "or" });

  body.append(
    bridgeBlock,
    bridgeDivider,
    el("div", { class: "opt" },
      el("div", { class: "opt-title", text: "Account" }),
      googleBtn
    ),
    el("div", { class: "divider", text: "or" }),
    el("div", { class: "opt" },
      el("div", { class: "opt-title", text: "Scan with the app" }),
      qrBox
    ),
    el("div", { class: "divider", text: "or" }),
    el("div", { class: "opt" },
      el("div", { class: "opt-title", text: "Paste a session token" }),
      el("div", { class: "opt-note" }, "Already signed in on themoviebox.xyz? ", blLink),
      el("div", { class: "opt-row" }, tokenInput, tokenBtn)
    ),
    status
  );

  const modal = el(
    "div",
    { class: "modal-mask", onclick: (e) => { if (e.target.classList.contains("modal-mask")) close(); } },
    el(
      "div",
      { class: "modal" },
      el("div", { class: "modal-head" }, el("h3", { text: "Sign in" }),
        el("button", { class: "modal-close", html: "&times;", onclick: close })),
      body
    )
  );

  root.append(modal);
  startQr();
}

/* Bridge session state (set once detected) */
let bridgeState = { running: false, loggedIn: false };
function setBridgeState(s) {
  bridgeState = { ...bridgeState, ...s };
}

function reflectAccount() {
  const btn = $("#account-btn");
  const label = $("#account-label");
  if (isLoggedIn()) {
    const u = getUser();
    label.textContent = u?.nickname || u?.name || u?.userName || "Account";
    btn.classList.add("signed");
  } else if (bridgeState.loggedIn) {
    label.textContent = bridgeState.nickname || "Browser session";
    btn.classList.add("signed");
  } else {
    label.textContent = "Sign in";
    btn.classList.remove("signed");
  }
}

/* ══ router ═══════════════════════════════════════════════════════════════ */

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const params = new URLSearchParams(queryPart || "");
  const parts = pathPart.split("/").filter(Boolean);
  return { parts, params };
}

function setActiveNav(hashKey) {
  document.querySelectorAll("#nav a, .drawer-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.key === hashKey);
  });
}

/* ── sidebar drawer (mobile categories) ─────────────────────────────────── */

let drawerEl = null;

function closeDrawer() {
  if (!drawerEl) return;
  const el = drawerEl;
  drawerEl = null;
  el.querySelector(".drawer")?.classList.remove("open");
  const mask = el.querySelector(".drawer-mask");
  if (mask) mask.style.opacity = "0";
  setTimeout(() => el.remove(), 200);
  $("#menu-btn")?.setAttribute("aria-expanded", "false");
}

function openDrawer() {
  if (drawerEl) return;
  const host = $("#drawer-root");
  if (!host) return;
  const list = el("div", { class: "drawer-list" });
  NAV.forEach((n) =>
    list.append(
      el("a", {
        class: "drawer-item",
        href: n.href,
        dataset: { key: n.key },
        html: (NAV_ICONS[n.key] || "") + "<span>" + n.label + "</span>",
        onclick: () => closeDrawer(),
      })
    )
  );

  const signedIn = isLoggedIn() || bridgeState.loggedIn;
  const accountBtn = el("button", {
    class: "btn" + (signedIn ? "" : " btn-primary"),
    text: signedIn ? (getUser()?.nickname || bridgeState.nickname || "Account") : "Sign in",
    onclick: () => {
      closeDrawer();
      $("#account-btn").click();
    },
  });

  const root = el(
    "div",
    {},
    el("div", { class: "drawer-mask", onclick: () => closeDrawer() }),
    el(
      "aside",
      { class: "drawer", role: "dialog", "aria-label": "Categories" },
      el(
        "div",
        { class: "drawer-head" },
        el("span", { class: "drawer-title", html: NAV_ICONS.home + "<span>notmoviebox</span>" }),
        el("button", { class: "drawer-close", html: "&times;", "aria-label": "Close", onclick: () => closeDrawer() })
      ),
      list,
      el("div", { class: "drawer-foot" }, accountBtn)
    )
  );

  host.append(root);
  drawerEl = root;
  requestAnimationFrame(() => root.querySelector(".drawer").classList.add("open"));
  $("#menu-btn")?.setAttribute("aria-expanded", "true");

  const key = currentNavKey();
  root.querySelectorAll(".drawer-item").forEach((a) => a.classList.toggle("active", a.dataset.key === key));
}

function currentNavKey() {
  const { parts } = parseRoute();
  const [seg, arg] = parts;
  if (!seg) return "home";
  if (seg === "channel") return Number(arg) === 1 ? "movie" : Number(arg) === 2 ? "tv" : Number(arg) === 4 ? "anime" : "";
  if (seg === "browse") return arg === "ONEROOM_MIDNIGHT" ? "midnight" : "";
  if (seg === "ranking") return "ranking";
  return "";
}

function route() {
  runCleanups();
  const { parts, params } = parseRoute();
  const [seg, arg] = parts;

  if (!seg) {
    setActiveNav("home");
    viewHome();
  } else if (seg === "channel") {
    setActiveNav(Number(arg) === 1 ? "movie" : Number(arg) === 2 ? "tv" : Number(arg) === 4 ? "anime" : "");
    viewChannel(arg, params);
  } else if (seg === "browse") {
    setActiveNav(arg === "ONEROOM_MIDNIGHT" ? "midnight" : "");
    viewBrowse(arg);
  } else if (seg === "ranking") {
    setActiveNav("ranking");
    viewRanking(arg);
  } else if (seg === "collection") {
    setActiveNav("");
    viewCollection(arg, params);
  } else if (seg === "search") {
    setActiveNav("");
    viewSearch(decodeURIComponent(arg || ""));
  } else if (seg === "title") {
    setActiveNav("");
    viewDetail(decodeURIComponent(arg || ""));
  } else {
    setActiveNav("home");
    viewHome();
  }
}

/* ══ boot ═════════════════════════════════════════════════════════════════ */

const NAV_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2.5 10.5V21h6.5v-6h6v6H21V10.5z"/></svg>',
  movie: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v2h2V6H5zm12 0v2h2V6h-2zM5 10v2h2v-2H5zm12 0v2h2v-2h-2zM5 14v2h2v-2H5zm12 0v2h2v-2h-2zM5 18v1h2v-2H5v1zm12-1v2h2v-2h-2zM9 6v12h6V6H9z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zm-1 11H4V8h16v9zM8 3h8v2H8z"/></svg>',
  anime: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM18.5 14l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9zM5.5 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
  midnight: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
  ranking: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 13h4v7H4zm6-6h4v13h-4zm6 3h4v10h-4z"/></svg>',
};

function buildNav() {
  const nav = $("#nav");
  if (!nav) return;
  nav.innerHTML = "";
  NAV.forEach((n) => nav.append(el("a", { href: n.href, dataset: { key: n.key }, text: n.label })));
}

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
});

$("#account-btn").addEventListener("click", () => {
  if (isLoggedIn()) {
    if (confirm("Sign out of notmoviebox?")) {
      api.logout().catch(() => {});
      setUserToken("");
      setUser(null);
      reflectAccount();
      toast("Signed out");
    }
  } else {
    openLogin();
  }
});

buildNav();
reflectAccount();
window.addEventListener("hashchange", route);
window.addEventListener("hashchange", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawerEl) closeDrawer();
});
// Guard so a stale/mismatched DOM can never blank the page.
const menuBtn = $("#menu-btn");
if (menuBtn) menuBtn.addEventListener("click", () => (drawerEl ? closeDrawer() : openDrawer()));
route();

// Detect an already-running browser bridge (survives server restarts).
bridgeApi
  .status()
  .then((s) => {
    setBridgeState(s);
    if (s?.running) return bridgeApi.session().then((sess) => { setBridgeState(sess); reflectAccount(); });
  })
  .catch(() => {});
