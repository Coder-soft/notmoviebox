// notmoviebox — shared proxy core.
//
// Pure, platform-agnostic logic used by both the local Node server
// (server/index.mjs) and the Cloudflare Worker (worker/index.js).
// No node: builtins, no fs, no child_process — only fetch/URL/TextEncoder,
// all of which exist in Node 20+ and in the Workers runtime.

export const UPSTREAM = "https://h5-api.aoneroom.com";
export const BFF = "/wefeed-h5api-bff";
export const SITE_HOST = "themoviebox.xyz";
export const REFERER = `https://${SITE_HOST}/`;
export const ORIGIN = `https://${SITE_HOST}`;
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
};

/* ── base64url (UTF-8 safe, no Buffer) ─────────────────────────────────────── */

export function b64e(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64d(b64) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ── guest token ──────────────────────────────────────────────────────────── */

export function jwtExp(token) {
  try {
    const payload = JSON.parse(b64d(token.split(".")[1]));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export function tokenFromXUser(value) {
  if (!value) return "";
  try {
    return JSON.parse(value).token || "";
  } catch {
    return "";
  }
}

let guest = { token: "", exp: 0 };

async function refreshGuestToken() {
  try {
    const r = await fetch(`${UPSTREAM}${BFF}/country-code`, {
      headers: { Accept: "application/json", Origin: ORIGIN },
    });
    const tok = tokenFromXUser(r.headers.get("x-user"));
    if (tok) guest = { token: tok, exp: jwtExp(tok) };
  } catch {
    /* keep the old token */
  }
}

export async function guestToken() {
  const now = Math.floor(Date.now() / 1000);
  if (!guest.token || guest.exp - now < 300) await refreshGuestToken();
  return guest.token;
}

export function rememberGuestFrom(headers) {
  const tok = tokenFromXUser(headers.get("x-user"));
  if (tok) guest = { token: tok, exp: jwtExp(tok) };
  return tok;
}

/* ── API request shaping ──────────────────────────────────────────────────── */

export function refererFor(detailPath, subjectId) {
  if (!detailPath) return REFERER;
  return `https://${SITE_HOST}/movies/${detailPath}?id=${subjectId || ""}&type=/movie/detail&detailSe=&detailEp=&lang=en`;
}

/**
 * Build the upstream BFF URL. Free playback is gated on the /movies/ Referer and
 * the codec capability hints, so /subject/play gets those appended.
 */
export function upstreamUrl(relPath, search) {
  let path = BFF + relPath + search;
  if (relPath === "/subject/play" && !/[?&]supportCodecs/.test(path)) {
    path += "&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1";
  }
  return UPSTREAM + path;
}

export function apiHeaders({ clientToken, token, relPath, detailPath, subjectId, lang }) {
  const headers = {
    Accept: "application/json",
    "content-type": "application/json",
    "X-Client-Info": JSON.stringify({ timezone: "Asia/Kolkata" }),
    "X-Request-Lang": lang || "en",
    "X-Vip-Restrict": "1",
    "X-No-High-Risk-Restrict": "1",
    Origin: ORIGIN,
    Referer: REFERER,
    "User-Agent": BROWSER_UA,
  };
  if (/^\/subject\/(play|caption)$/.test(relPath)) {
    headers.Referer = refererFor(detailPath, subjectId);
  }
  const t = clientToken || token;
  if (t) headers.Authorization = `Bearer ${t}`;
  return headers;
}

export const isSessionPath = (relPath) =>
  /^\/(subject\/(play|caption)|user\/profile)/.test(relPath);

/* ── media proxy helpers ──────────────────────────────────────────────────── */

const cookieJar = new Map(); // host -> { cookie, ts }
const COOKIE_TTL = 10 * 60 * 1000;

export async function primeCookies(prePlayUrl) {
  let host;
  try {
    host = new URL(prePlayUrl).host;
  } catch {
    return;
  }
  const cached = cookieJar.get(host);
  if (cached && Date.now() - cached.ts < COOKIE_TTL) return;
  try {
    const r = await fetch(prePlayUrl, {
      headers: { Referer: REFERER, Origin: ORIGIN, "User-Agent": BROWSER_UA },
    });
    const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (cookie) cookieJar.set(host, { cookie, ts: Date.now() });
  } catch {
    /* non-fatal */
  }
}

export function cookieFor(mediaUrl) {
  try {
    const jar = cookieJar.get(new URL(mediaUrl).host);
    if (jar && Date.now() - jar.ts < COOKIE_TTL) return jar.cookie;
  } catch {
    /* ignore */
  }
  return "";
}

export function mediaHeaders({ mediaUrl, headerName, headerValue, pp, range }) {
  const headers = {
    Referer: REFERER,
    Origin: ORIGIN,
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
  };
  if (headerName && headerValue) headers[headerName] = headerValue;
  if (range) headers.Range = range;
  const cookie = cookieFor(mediaUrl);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export function mediaParams(headerName, headerValue, pp) {
  return (
    (headerName && headerValue
      ? `&h=${encodeURIComponent(headerName)}&v=${encodeURIComponent(headerValue)}`
      : "") + (pp ? `&pp=${encodeURIComponent(pp)}` : "")
  );
}

export function isPlaylist(ctype, mediaUrl) {
  return /mpegurl|x-mpegURL/i.test(ctype) || /\.m3u8(\?|$)/i.test(mediaUrl);
}

export function isDash(ctype, mediaUrl) {
  return /dash\+xml/i.test(ctype) || /\.mpd(\?|$)/i.test(mediaUrl);
}

export function rewritePlaylist(text, baseUrl, params, proxyBase = "") {
  const keep = (u) => `${proxyBase}/media?u=${b64e(new URL(u, baseUrl).toString())}${params}`;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${keep(u)}"`);
      return keep(trimmed);
    })
    .join("\n");
}

/**
 * DASH manifests use relative SegmentTemplate URLs, so dash.js resolves them
 * against the manifest URL. Point <BaseURL> at the path-based proxy so segments
 * come back through us (keeping the signed header).
 */
export function rewriteDash(text, mpdUrl, headerName, headerValue, pp, proxyBase = "") {
  const dir = new URL(".", mpdUrl).toString();
  const token = b64e(JSON.stringify({ b: dir, h: headerName || "", v: headerValue || "", pp: pp || "" }));
  const base = `${proxyBase}/media/${token}/`;
  if (/<BaseURL>/.test(text)) return text.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/, `<BaseURL>${base}</BaseURL>`);
  return text.replace(/(<MPD\b[^>]*>)/, `$1<BaseURL>${base}</BaseURL>`);
}

export function decodeMediaPath(pathname) {
  // /media/<token>/<relative>
  const rest = pathname.slice("/media/".length);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest : rest.slice(0, slash);
  const rel = slash === -1 ? "" : rest.slice(slash + 1);
  const cfg = JSON.parse(b64d(token));
  return { mediaUrl: new URL(rel, cfg.b).toString(), headerName: cfg.h, headerValue: cfg.v, pp: cfg.pp };
}
