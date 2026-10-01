// notmoviebox — Cloudflare Worker.
//
// Serves the static SPA from the ASSETS binding, proxies the MovieBox BFF
// (/api/*) and proxies CDN media (/media, /media/<token>/<rel>) with the
// Referer + signed-header + HLS/DASH rewriting the player needs.
//
// The browser bridge is Node-only (it launches Chrome), so those routes report
// as unavailable here; the frontend hides that sign-in option automatically.

import * as core from "../shared/core.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...core.CORS, "content-type": "application/json; charset=utf-8" },
  });

/**
 * Serve a static asset, injecting the relay base into index.html when
 * RELAY_BASE is configured. The MovieBox API 429s Cloudflare's egress IPs, so a
 * Worker cannot call it directly; pointing the browser at a relay that can
 * (your machine via a Cloudflare Tunnel, a VPS, a non-Cloudflare free host)
 * makes the deployed Workers URL fully functional.
 */
async function serveAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  const ctype = res.headers.get("content-type") || "";
  const relay = (env && env.RELAY_BASE) || "";
  if (!relay || !ctype.includes("text/html")) return res;

  const html = await res.text();
  const patched = html.replace(
    /<meta name="proxy-base" content="[^"]*"\s*\/?>/,
    `<meta name="proxy-base" content="${relay.replace(/\/+$/, "")}">`
  );
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-cache, must-revalidate");
  return new Response(patched, { status: res.status, headers });
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const buf = await request.arrayBuffer();
  return buf.byteLength ? buf : undefined;
}

async function handleApi(request, url) {
  const relPath = url.pathname.replace(/^\/api/, "");
  const detailPath = url.searchParams.get("detailPath");
  const subjectId = url.searchParams.get("subjectId");

  const clientToken = request.headers.get("x-mb-token") || "";
  const token = clientToken || (await core.guestToken());
  const headers = core.apiHeaders({
    clientToken,
    token,
    relPath,
    detailPath,
    subjectId,
    lang: request.headers.get("x-request-lang"),
  });

  const target = core.upstreamUrl(relPath, url.search);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: await readBody(request),
      redirect: "follow",
    });
  } catch (err) {
    return json(502, { error: "upstream_unreachable", detail: String(err) });
  }

  const out = new Headers(core.CORS);
  out.set("content-type", upstream.headers.get("content-type") || "application/json");
  const fresh = core.rememberGuestFrom(upstream.headers);
  if (fresh) out.set("x-mb-token", fresh);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function handleMedia(request, url) {
  let mediaUrl;
  let headerName;
  let headerValue;
  let pp;

  if (url.pathname === "/media") {
    const u = url.searchParams.get("u");
    if (!u) return json(400, { error: "missing_u" });
    try {
      mediaUrl = core.b64d(u);
      new URL(mediaUrl);
    } catch {
      return json(400, { error: "bad_u" });
    }
    headerName = url.searchParams.get("h");
    headerValue = url.searchParams.get("v");
    pp = url.searchParams.get("pp");
  } else {
    try {
      ({ mediaUrl, headerName, headerValue, pp } = core.decodeMediaPath(url.pathname));
    } catch {
      return json(400, { error: "bad_path" });
    }
  }

  if (pp) {
    try {
      await core.primeCookies(core.b64d(pp));
    } catch {
      /* ignore */
    }
  }

  const headers = core.mediaHeaders({
    mediaUrl,
    headerName,
    headerValue,
    pp,
    range: request.headers.get("range") || "",
  });

  let upstream;
  try {
    upstream = await fetch(mediaUrl, { headers, redirect: "follow" });
  } catch (err) {
    return json(502, { error: "media_unreachable", detail: String(err) });
  }

  const ctype = upstream.headers.get("content-type") || "";

  if (core.isPlaylist(ctype, mediaUrl) && upstream.ok) {
    const text = await upstream.text();
    return new Response(
      core.rewritePlaylist(text, mediaUrl, core.mediaParams(headerName, headerValue, pp), url.origin),
      { status: 200, headers: { ...core.CORS, "content-type": "application/vnd.apple.mpegurl; charset=utf-8" } }
    );
  }

  if (core.isDash(ctype, mediaUrl) && upstream.ok) {
    const text = await upstream.text();
    return new Response(core.rewriteDash(text, mediaUrl, headerName, headerValue, pp, url.origin), {
      status: 200,
      headers: { ...core.CORS, "content-type": "application/dash+xml; charset=utf-8" },
    });
  }

  const out = new Headers(core.CORS);
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: core.CORS });

    if (url.pathname === "/health") return json(200, { ok: true, runtime: "workers" });

    // The Chrome bridge cannot run on Workers — report it as unavailable.
    if (url.pathname === "/api/bridge/status" || url.pathname === "/api/bridge/session") {
      return json(200, { running: false, available: false, loggedIn: false });
    }
    if (url.pathname === "/api/bridge/start" || url.pathname === "/api/bridge/stop") {
      return json(501, { error: "bridge_unavailable", available: false });
    }

    if (url.pathname.startsWith("/api/")) return handleApi(request, url);
    if (url.pathname === "/media" || url.pathname.startsWith("/media/")) return handleMedia(request, url);

    return serveAsset(request, env);
  },
};
