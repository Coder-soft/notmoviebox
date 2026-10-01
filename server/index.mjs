// notmoviebox — local Node server.
//
// Zero dependencies (Node built-ins only). Serves the static SPA, proxies the
// MovieBox BFF API (/api/*), proxies CDN media (/media, /media/<token>/<rel>),
// and exposes the optional Chrome bridge (Node-only, for signed-in sessions).
//
// Shared proxy logic lives in ../shared/core.js. Node >= 20.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridge } from "./bridge.mjs";
import * as core from "../shared/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/* ── helpers ──────────────────────────────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body == null) return res.end();
  if (Buffer.isBuffer(body) || typeof body === "string") return res.end(body);
  if (typeof body.pipe === "function") {
    body.on("error", () => res.destroy());
    return body.pipe(res);
  }
  const nodeStream = Readable.fromWeb(body);
  nodeStream.on("error", () => res.destroy());
  return nodeStream.pipe(res);
}

function json(res, status, obj) {
  send(res, status, { ...core.CORS, "content-type": "application/json; charset=utf-8" }, JSON.stringify(obj));
}

/* ── API proxy ────────────────────────────────────────────────────────────── */

async function handleApi(req, res, url) {
  const relPath = url.pathname.replace(/^\/api/, "");
  const detailPath = url.searchParams.get("detailPath");
  const subjectId = url.searchParams.get("subjectId");

  // Session-bound calls run inside the bridged browser when it is available.
  if (bridge.running && core.isSessionPath(relPath)) {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = await readBody(req);
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString());
        } catch {
          body = undefined;
        }
      }
    }
    const referrer = /^\/subject\/(play|caption)$/.test(relPath)
      ? core.refererFor(detailPath, subjectId)
      : undefined;
    const data = await bridge.call(relPath + url.search, { method: req.method, body, referrer });
    return json(res, 200, data);
  }

  const clientToken = req.headers["x-mb-token"] || "";
  const token = clientToken || (await core.guestToken());
  const headers = core.apiHeaders({
    clientToken,
    token,
    relPath,
    detailPath,
    subjectId,
    lang: req.headers["x-request-lang"],
  });

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await readBody(req);
    body = raw.length ? raw : undefined;
  }

  let upstream;
  try {
    upstream = await fetch(core.upstreamUrl(relPath, url.search), {
      method: req.method,
      headers,
      body,
      redirect: "follow",
    });
  } catch (err) {
    return json(res, 502, { error: "upstream_unreachable", detail: String(err) });
  }

  const out = { ...core.CORS, "content-type": upstream.headers.get("content-type") || "application/json" };
  const fresh = core.rememberGuestFrom(upstream.headers);
  if (fresh) out["x-mb-token"] = fresh;
  send(res, upstream.status, out, upstream.body);
}

/* ── media proxy ──────────────────────────────────────────────────────────── */

async function proxyMedia(req, res, mediaUrl, headerName, headerValue, pp) {
  if (pp) {
    try {
      await core.primeCookies(core.b64d(pp));
    } catch {
      /* ignore */
    }
  }

  // Absolute base so rewritten HLS/DASH URLs work even when this proxy is not
  // on the same origin as the page (e.g. Worker UI + external proxy).
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proxyBase = `${proto}://${host}`;

  const headers = core.mediaHeaders({
    mediaUrl,
    headerName,
    headerValue,
    pp,
    range: req.headers["range"] || "",
  });
  if (req.headers["if-none-match"]) headers["If-None-Match"] = req.headers["if-none-match"];
  if (req.headers["if-modified-since"]) headers["If-Modified-Since"] = req.headers["if-modified-since"];

  let upstream;
  try {
    upstream = await fetch(mediaUrl, { headers, redirect: "follow" });
  } catch (err) {
    return json(res, 502, { error: "media_unreachable", detail: String(err) });
  }

  const ctype = upstream.headers.get("content-type") || "";

  if (core.isPlaylist(ctype, mediaUrl) && upstream.ok) {
    const text = await upstream.text();
    return send(
      res,
      200,
      { ...core.CORS, "content-type": "application/vnd.apple.mpegurl; charset=utf-8" },
      core.rewritePlaylist(text, mediaUrl, core.mediaParams(headerName, headerValue, pp), proxyBase)
    );
  }

  if (core.isDash(ctype, mediaUrl) && upstream.ok) {
    const text = await upstream.text();
    return send(
      res,
      200,
      { ...core.CORS, "content-type": "application/dash+xml; charset=utf-8" },
      core.rewriteDash(text, mediaUrl, headerName, headerValue, pp, proxyBase)
    );
  }

  const out = { ...core.CORS };
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
    if (v) out[h] = v;
  }
  send(res, upstream.status, out, upstream.body);
}

async function handleMedia(req, res, url) {
  const u = url.searchParams.get("u");
  if (!u) return json(res, 400, { error: "missing_u" });
  let mediaUrl;
  try {
    mediaUrl = core.b64d(u);
    new URL(mediaUrl);
  } catch {
    return json(res, 400, { error: "bad_u" });
  }
  return proxyMedia(req, res, mediaUrl, url.searchParams.get("h"), url.searchParams.get("v"), url.searchParams.get("pp"));
}

async function handleMediaPath(req, res, url) {
  let cfg;
  try {
    cfg = core.decodeMediaPath(url.pathname);
  } catch {
    return json(res, 400, { error: "bad_path" });
  }
  return proxyMedia(req, res, cfg.mediaUrl, cfg.headerName, cfg.headerValue, cfg.pp);
}

/* ── static files ─────────────────────────────────────────────────────────── */

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("dir");
    const ext = path.extname(filePath).toLowerCase();
    const dynamic = [".html", ".css", ".js", ".mjs", ".json"].includes(ext);
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": dynamic ? "no-cache, must-revalidate" : "public, max-age=86400",
    };
    if (req.method === "HEAD") return send(res, 200, headers);
    return send(res, 200, headers, createReadStream(filePath));
  } catch {
    try {
      const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
      return send(res, 200, { "content-type": MIME[".html"] }, html);
    } catch {
      return json(res, 404, { error: "not_found" });
    }
  }
}

/* ── router ───────────────────────────────────────────────────────────────── */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") return send(res, 204, core.CORS);

    try {
      if (url.pathname === "/health") return json(res, 200, { ok: true, runtime: "node" });
      if (url.pathname === "/api/bridge/status") return json(res, 200, bridge.status());
      if (url.pathname === "/api/bridge/session") return json(res, 200, await bridge.session());
      if (url.pathname === "/api/bridge/start") {
        try {
          return json(res, 200, await bridge.start());
        } catch (err) {
          return json(res, 500, { error: String(err.message || err), code: err.code || "start_failed" });
        }
      }
      if (url.pathname === "/api/bridge/stop") return json(res, 200, bridge.stop());
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (url.pathname.startsWith("/media/")) return await handleMediaPath(req, res, url);
      if (url.pathname === "/media") return await handleMedia(req, res, url);
      return await handleStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      json(res, 500, { error: "internal", detail: String(err) });
    }
  });
}

// A fresh server per attempt: reusing one object would accumulate `listening`
// callbacks across retries, so every attempted port would log a startup line.
function start(port, attempts = 10) {
  const server = createServer();
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempts > 0) {
      console.warn(`Port ${port} in use, trying ${port + 1}…`);
      start(port + 1, attempts - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log(`notmoviebox  ->  http://${HOST}:${port}`);
    console.log(`api proxy    ->  ${core.UPSTREAM}${core.BFF}`);
  });
}

start(PORT);
