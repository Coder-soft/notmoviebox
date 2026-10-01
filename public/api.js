// notmoviebox — API client.
//
// All calls go through the local server (/api/*), which injects the required
// headers, a guest bearer token and the upstream host. When the user logs in we
// keep their token in localStorage and send it as `x-mb-token`, which the server
// forwards as `Authorization`. All BFF responses look like {code,message,data}.

const TOKEN_KEY = "nmb_token";
const USER_KEY = "nmb_user";

// Optional absolute proxy base (set via <meta name="proxy-base" content="...">).
// Empty means "same origin" — the local Node server and a full Worker deploy.
// The deployed Worker UI can point this at a proxy that can reach the MovieBox
// API (the API returns 429 to Cloudflare's egress IPs).
export const PROXY_BASE = (() => {
  try {
    const meta = document.querySelector('meta[name="proxy-base"]');
    return (meta?.content || "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
})();

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

async function request(path, { method = "GET", body, query } = {}) {
  let url = PROXY_BASE + "/api" + path;
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

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bad response (${res.status})`);
  }
  if (json.code !== 0 && json.code !== 200) {
    const err = new Error(json.message || json.reason || "Request failed");
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
  status: () => fetch(PROXY_BASE + "/api/bridge/status").then((r) => r.json()),
  session: () => fetch(PROXY_BASE + "/api/bridge/session").then((r) => r.json()),
  start: () => fetch(PROXY_BASE + "/api/bridge/start", { method: "POST" }).then((r) => r.json()),
  stop: () => fetch(PROXY_BASE + "/api/bridge/stop", { method: "POST" }).then((r) => r.json()),
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
  return PROXY_BASE + "/media?" + params.toString();
}

// ── Presentation helpers ─────────────────────────────────────────────────────

export const IMG = {
  cover: (s) => s?.cover?.url || s?.image?.url || "",
  still: (s) => s?.stills?.url || s?.cover?.url || "",
  backdrop: (s) => s?.stills?.url || s?.still?.url || s?.cover?.url || "",
};

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
