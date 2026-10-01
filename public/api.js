// notmoviebox — API client.
//
// All calls go through the local server (/api/*), which injects the required
// headers, a guest bearer token and the upstream host. When the user logs in we
// keep their token in localStorage and send it as `x-mb-token`, which the server
// forwards as `Authorization`. All BFF responses look like {code,message,data}.

const TOKEN_KEY = "nmb_token";
const USER_KEY = "nmb_user";

export function getUserToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setUserToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setUser(user) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function isLoggedIn() {
  return !!getUserToken();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = "GET", body, query } = {}) {
  let url = "/api" + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += "?" + s;
  }

  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = getUserToken();
  if (token) headers["x-mb-token"] = token;

  const init = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  // The upstream BFF occasionally drops a connection or answers 502/503/504 for
  // a moment. Safe methods get one silent retry so a hiccup doesn't blank a page.
  const retriable = method === "GET" || method === "HEAD";
  const attempts = retriable ? 2 : 1;
  let res = null;
  let netErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      res = await fetch(url, init);
      netErr = null;
      if (retriable && i < attempts - 1 && [502, 503, 504].includes(res.status)) {
        await sleep(500);
        continue;
      }
      break;
    } catch (err) {
      netErr = err;
      res = null;
      if (i < attempts - 1) {
        await sleep(500);
        continue;
      }
    }
  }
  if (netErr) throw new Error("Can't reach the local server — is it still running?");

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from the server (${res.status}${res.statusText ? " " + res.statusText : ""})`);
  }
  if (json.code !== 0 && json.code !== 200) {
    const err = new Error(json.message || json.reason || `Request failed (${res.status})`);
    err.code = json.code;
    err.payload = json;
    throw err;
  }
  return json.data;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export const api = {
  home: (host = "themoviebox.xyz") => request("/home", { query: { host } }),

  bottomTabs: () => request("/tab/get-bottom-tab-list"),

  tabOperating: (tabId, host = "themoviebox.xyz") =>
    request("/tab-operating", { query: { tabId, host } }),

  trending: (tabId, page = 1, perPage = 18) =>
    request("/subject/trending", { query: { tabId, page, perPage } }),

  filter: (body) => request("/subject/filter", { method: "POST", body }),

  search: ({ keyword, page = 1, perPage = 18, subjectType }) =>
    request("/subject/search", {
      method: "POST",
      body: { keyword, page, perPage, ...(subjectType ? { subjectType } : {}) },
    }),

  everyoneSearch: () => request("/subject/everyone-search"),

  detail: (detailPath, se) =>
    request("/detail", { query: { detailPath, se } }),

  detailRec: (subjectId, page = 1, perPage = 12) =>
    request("/subject/detail-rec", { query: { subjectId, page, perPage } }),

  ranking: (id, page = 1, perPage = 20) =>
    request("/ranking-list/content", { query: { id, page, perPage } }),

  play: ({ subjectId, se, ep, detailPath }) =>
    request("/subject/play", {
      query: {
        subjectId,
        se,
        ep,
        detailPath,
        streamSignType: 1,
      },
    }),

  caption: ({ format, id, subjectId, detailPath }) =>
    request("/subject/caption", {
      query: { format, id, subjectId, detailPath },
    }),

  profile: () => request("/user/profile"),

  googleLogin: ({ idToken, accessToken }) =>
    request("/user/google-login", { method: "POST", body: { idToken, accessToken } }),

  qrCreate: () => request("/user/qr-login-create", { method: "POST", body: {} }),

  qrPoll: ({ ticket, lastStatus }) =>
    request("/user/qr-login-poll", { method: "POST", body: { ticket, lastStatus } }),

  qrFetch: ({ ticket }) =>
    request("/user/qr-login-fetch", { method: "POST", body: { ticket } }),

  logout: () => request("/user/logout", { method: "POST", body: {} }),
};

// ── Browser bridge (uses a real signed-in Chrome session) ────────────────────

export const bridgeApi = {
  status: () => fetch("/api/bridge/status").then((r) => r.json()),
  session: () => fetch("/api/bridge/session").then((r) => r.json()),
  start: () => fetch("/api/bridge/start", { method: "POST" }).then((r) => r.json()),
  stop: () => fetch("/api/bridge/stop", { method: "POST" }).then((r) => r.json()),
};

// ── Media proxy helpers ──────────────────────────────────────────────────────

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Wrap a CDN URL so it is fetched through the local media proxy.
 * `signedHeader` is the {name,value} pair MovieBox returns as
 * signHeaderKey/signCookie; `prePlay` is the prePlayApi URL used to seed the
 * CDN cookies.
 */
export function mediaUrl(rawUrl, { signHeaderKey, signCookie, prePlayApi } = {}) {
  if (!rawUrl) return "";
  const params = new URLSearchParams();
  params.set("u", b64url(rawUrl));
  if (signHeaderKey && signCookie) {
    params.set("h", signHeaderKey);
    params.set("v", signCookie);
  }
  if (prePlayApi) params.set("pp", b64url(prePlayApi));
  return "/media?" + params.toString();
}

// ── Presentation helpers ─────────────────────────────────────────────────────

export const IMG = {
  cover: (s) => s?.cover?.url || s?.image?.url || "",
  still: (s) => s?.stills?.url || s?.cover?.url || "",
  backdrop: (s) => s?.stills?.url || s?.still?.url || s?.cover?.url || "",
};

/**
 * Ask the MovieBox CDN to downscale an image.
 *
 * The originals are multi-megabyte (the home page alone references ~205 MB of
 * artwork). The CDN is Alibaba OSS-backed and honours `x-oss-process`.
 * `format,jpg` is essential: without it OSS re-encodes to PNG and a thumbnail
 * stays ~200 KB; with it the same thumbnail is ~20 KB.
 */
export function img(url, width = 320, quality = 70) {
  if (!url) return "";
  if (url.includes("x-oss-process=")) return url;
  if (!/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return url;
  if (!/aoneroom\.com/i.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}x-oss-process=image/resize,w_${width}/format,jpg/quality,q_${quality}`;
}


export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function subjectYear(s) {
  return (s?.releaseDate || "").slice(0, 4);
}
