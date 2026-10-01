# AGENTS.md

Orientation for anyone (human or agent) working in this repo. Read this before
changing code. It captures the non-obvious decisions and gotchas that are easy to
"fix" wrongly.

## What this is

A **standalone** replacement frontend for [themoviebox.xyz](https://themoviebox.xyz).
It keeps every category from the original site and plays everything through the
[moviethon](https://github.com/Coder-soft/moviethon) player, vendored and adapted
into this app.

Hard requirements that shaped the design:

- **Standalone, no compromises.** Not a userscript, not a browser extension, not
  an iframe of the original site. It is its own app that talks to the same public
  MovieBox BFF API.
- **Ad- and popup-free viewing.** That is the entire point.
- **Play the best video the API provides**, at whatever quality is available —
  including for VIP-marked content. moviethon plays the best video provided
  through the API using the video links, and it must stay that way.
- **Mobile-first.** All top categories plus the sign-in button must fit; the nav
  is a **sidebar drawer**.
- **Low-end phone performance matters.** See "Performance rules" — do not undo it.

## Quick start

```bash
npm start            # http://127.0.0.1:8787 (auto-bumps the port if busy)
npm run dev          # same, with --watch
npm run share        # LAN + Tailscale, prints reachable URLs
npm run link         # put `notmoviebox` / `nmb` on PATH
```

Node **20+**. **Zero dependencies** — no `npm install` needed, ever.

Container: `docker build -t notmoviebox . && docker run -p 8787:8787 notmoviebox`

## File map

```
public/            static SPA (vanilla JS, no build step)
  index.html       shell; loads styles.css and app.js with a ?v= cache-bust
  styles.css       app theme + moviethon player styles
  api.js           API client, token storage, media-proxy URL builder, img() resize
  app.js           hash router + views (home, channels, browse, ranking,
                   collection, search, detail) + auth modal + drawer
  player.js        moviethon player, adapted to an ES module
  vendor/          hls.min.js (~414 KB) + dash.all.min.js (~794 KB), lazy-loaded
server/
  index.mjs        zero-dep Node server: static + API proxy + media proxy + bridge routes
  bridge.mjs       optional Chrome DevTools Protocol bridge for signed-in sessions
shared/core.js     platform-agnostic proxy core (request shaping, HLS/DASH rewriting)
scripts/
  share.mjs        LAN + Tailscale share (binds 0.0.0.0)
  link.mjs         link/unlink the CLI onto PATH
bin/notmoviebox.mjs  CLI entry (`share` default, `serve`, `help`, `version`)
research/moviethon.user.js  original upstream userscript (reference only)
Dockerfile, .dockerignore, package.json
```

`shared/core.js` is deliberately free of `node:` builtins (fetch/URL/TextEncoder
only) so it stays portable. Keep it that way.

## The API

- Base: `https://h5-api.aoneroom.com/wefeed-h5api-bff`
- `host` query param: `themoviebox.xyz`
- `tabIds`: `ONEROOM_HOME`, `ONEROOM_MOVIE`, `ONEROOM_MIDNIGHT`
- `channelId` == `subjectType`: `1` movies, `2` TV, `4` anime
- **Guest token**: the API hands an anonymous token in the `x-user` **response**
  header (a JSON blob with `.token`). `shared/core.js` keeps one warm, refreshes it
  before expiry, and injects it as `Authorization: Bearer …`. Client-supplied
  tokens are forwarded as `x-mb-token` → `Authorization`.
- All BFF responses look like `{code, message, data}`; success is `code === 0` or
  `200`.

### Endpoints used

```
GET  /home                         GET  /detail
GET  /tab/get-bottom-tab-list      GET  /subject/detail-rec
GET  /tab-operating                GET  /ranking-list/content
GET  /subject/trending             GET  /subject/play
POST /subject/filter               GET  /subject/caption
POST /subject/search               GET  /subject/everyone-search
POST /user/google-login            POST /user/qr-login-create
POST /user/qr-login-poll           POST /user/qr-login-fetch
GET  /user/profile                 POST /user/logout
```

## Why there is a server

A plain static page cannot do two things from a different origin:

1. **Auth.** `/subject/play` and `/subject/search` need a bearer token; the server
   keeps a guest token warm and injects it on every `/api/*` call.
2. **Media.** The CDN sends no `Access-Control-Allow-Origin`, HLS/DASH are fetched
   with `fetch`/XHR (so CORS applies), and streams require a `Referer`, a signed
   header (`signHeaderKey`/`signCookie`) and cookies set by a pre-play API. The
   browser **cannot set `Referer` at all**. `/media?u=…` fetches server-side with
   the right headers and rewrites playlists so every variant/segment/key keeps
   flowing through the proxy.

This is the "no compromises" part — it makes playback work exactly like the real
site's session.

## Playback mechanics (do not regress)

**No account needed; it plays at 1080p.** Anonymous clients get the same thing the
official player gets: a free MP4 plus a **DASH ladder at 1080/720/480** (HEVC video
+ AAC audio). Two things gate it, both of which the site itself satisfies:

1. **Referer.** `/subject/play` must carry
   `Referer: https://themoviebox.xyz/movies/<detailPath>?id=<subjectId>&type=/movie/detail&detailSe=&detailEp=&lang=en`.
   Change it to `/detail/…` or drop it and the response comes back with **zero
   streams** — same token, same URL, only the Referer differs. See `refererFor()`.
2. **Signed header.** The DASH entry ships `signHeaderKey: "X-MB-Token"` plus a
   `signCookie` value. Without that header the CDN returns `403 ACCESS DENIED`; with
   it you get the full 1080p ladder. This is exactly what moviethon does.

The player defaults to the **highest-resolution source available** (DASH 1080p),
forces the top rendition, and falls back automatically if a codec can't decode.

`playConfig.maxResolution: 480` and `vipLocked: true` are still present in the
response, but the API also returns the DASH URL and its signed header to anonymous
clients, so the ladder is reachable. **Nothing is forged** — the app only uses the
URLs and tokens the API itself returns. Do not add token forging or DRM bypass.

### Media proxy

- `/media?u=<b64url>&h=<header name>&v=<header value>&pp=<b64 prePlayApi>` — the
  query form, used for direct asset URLs.
- `/media/<b64 token>/<relative>` — the **path form**, injected as `<BaseURL>` in
  rewritten DASH manifests so `SegmentTemplate` relative URLs resolve back through
  the proxy while keeping the signed header.
- HLS playlists are rewritten so every URI (variants, segments, keys) is proxied.
- `primeCookies()` seeds CDN cookies from the pre-play URL; the cookie jar is
  in-memory with a 10-minute TTL.
- `proxyBase` is derived from `x-forwarded-proto`/`x-forwarded-host` so rewritten
  URLs stay absolute even when the proxy is not on the page's origin.

## Categories and routes

Hash router (`parseRoute` / `route()` in `public/app.js`):

| Route | View | Source |
| --- | --- | --- |
| `#/` | Home | `/home?host=themoviebox.xyz` (hero banners + rows) |
| `#/channel/1\|2\|4` | Movies / TV / Anime | `/subject/filter` with genre/year/language filters |
| `#/browse/ONEROOM_MIDNIGHT` | Midnight | `/tab-operating` + `/subject/trending` |
| `#/ranking/<id>` | Top 100 | `/ranking-list/content` (7 curated menus) |
| `#/collection/<genreTopId>?title=…` | View-all grid | `/ranking-list/content?id=<genreTopId>` |
| `#/search/<q>` | Search | `/subject/search` + `/subject/everyone-search` |
| `#/title/<detailPath>` | Detail | `/detail`, `/subject/detail-rec`, trailer |

### "View all" rows

Home and tab rows are truncated (10–20 items). Each row carries a **`genreTopId`**;
`/ranking-list/content?id=<genreTopId>` expands it to the full paginated list — the
same endpoint the site's own "more" button uses. `moreHrefFor()` builds the
`#/collection/…` link; rows **without** a `genreTopId` (e.g. "Coming Soon", which
already ships its complete list) intentionally show no link. Do **not** revert this
to a title search — that returned the wrong content.

## Performance rules (low-end phones)

The lag was almost entirely images: the home page referenced **~205 MB** of artwork
to draw 150 px thumbnails. Current rules:

1. **Always route images through `img()`** (`public/api.js`). It appends
   `?x-oss-process=image/resize,w_<width>/format,jpg/quality,q_70`.
   - The CDN is Alibaba OSS-backed and honours `x-oss-process`.
   - **`format,jpg` is essential.** Without it OSS re-encodes to **PNG** and the
     "resized" thumbnail stays ~200 KB and ignores `quality`. With it, ~18 KB.
   - Widths in use: cards `320`, detail poster `400`, hero/detail backdrop `1600`
     (quality `75`). Home page went 205 MB → ~7 MB.
   - `img()` skips non-`aoneroom.com` hosts, non-image extensions, and URLs that
     already contain `x-oss-process=`.
2. **hls.js / dash.js are lazy-loaded.** `loadVendor()` in `player.js` injects them
   on first play. They must **not** be added back as eager `<script>` tags in
   `index.html` — that is ~1.2 MB of blocking JS on every page load.
3. **`content-visibility: auto`** on `.row` and `.card` so offscreen content isn't
   laid out/painted.
4. **`backdrop-filter` is disabled on mobile** (`max-width: 820px`) — a known cause
   of scroll jank on weak GPUs. The sticky topbar is the main offender.
5. Images use `loading="lazy"` and `decoding="async"`.

## Asset versioning (easy to get wrong)

`index.html` loads `/styles.css?v=N` and `/app.js?v=N`, and the modules import each
other with the same `?v=N`. **When you change any file under `public/`, bump `N`
everywhere** (`index.html`, and the `import … from "./api.js?v=N"` /
`"./player.js?v=N"` lines in `app.js` / `player.js`). A mismatch means a stale
cached module is served, and dynamic assets are served `no-cache` but static ones
are cached for a day. Currently `v=9`.

## Conventions

- **No build step, no dependencies, no framework.** Vanilla ES modules, `el()`
  DOM helper. Do not add a bundler or runtime dependency without a strong reason.
- ESM everywhere (`"type": "module"`), `node:`-prefixed builtins in `server/`.
- The server serves unknown paths by falling back to `index.html` (SPA).
- Static `.html/.css/.js/.mjs/.json` are `no-cache`; everything else is
  `public, max-age=86400`.
- Port retry creates a **fresh** server per attempt on purpose (reusing one object
  accumulates `listening` callbacks and logs a startup line per attempted port).

## Accounts (optional)

Signing in does not change what the free DASH ladder gives you. Four methods:

1. **Browser bridge** — drives a real Chrome with a persistent profile
   (`~/.notmoviebox/chrome-profile`), auto-discovers Chrome, override with
   `NMB_CHROME=/path/to/chrome`. Session-bound calls run inside that page.
2. **Continue with Google** — Firebase popup → `POST /user/google-login`.
3. **QR code** — scan with the MovieBox mobile app.
4. **Paste a session token** — bookmarklet from `themoviebox.xyz`.

Options 2–4 store the token in `localStorage` and send it as `x-mb-token`.

## Machine / environment gotchas (this machine)

- **Port 8787 is occupied by an unrelated `sync4` process**, so `npm start`
  auto-bumps to **8788**. Logs are written to `/tmp/nmb*.log` when started with
  `nohup`.
- **`tailscale serve` is broken on this macOS macsys build** —
  `The Tailscale GUI failed to start: … (Tailscale.CLIError error 3.)`. `share.mjs`
  times it out and falls back to the Tailscale IP URL, which works because the
  server binds `0.0.0.0`. Tailnet `tail33403e.ts.net`, node IP `100.99.82.53`,
  LAN IP `192.168.100.7`.
- **No system-wide Chrome/Chromium.** The bridge vendors/attaches its own. Do not
  install browsers.
- Start long-running processes as
  `nohup <cmd> </dev/null >logfile 2>&1 &` and verify via the log, not by hanging.

## Testing / verification

- Syntax: `node --check public/app.js public/player.js public/api.js`.
- Serve and curl: `/health` → `{"ok":true,"runtime":"node"}`; check the served
  `index.html` has the right `?v=` and **no eager `vendor/` scripts**.
- The API/CDN can be exercised directly with `fetch`/`curl` (the `/api/*` proxy is
  a thin wrapper). Use `Origin: https://themoviebox.xyz` when calling upstream.
- Browser automation tooling is **not guaranteed to be available**. When it isn't,
  verify by measuring the API/CDN responses and checking the served files, and say
  so plainly rather than claiming a UI click-through you didn't do.

## Hosting history (deliberate removals)

- Cloudflare Workers/Pages was tried and **abandoned**: the MovieBox API returns
  `429 RESOURCE_EXHAUSTED` to all Cloudflare egress IPs (verified; a non-Cloudflare
  egress like `r.jina.ai` worked). All Worker code, `wrangler.jsonc`, and free-hosting
  docs were removed in `d031c7f`. **Do not reintroduce a Cloudflare target.**
- The app is a plain local Node app. Sharing is via LAN/Tailscale (`scripts/share.mjs`).

## Repo / git

- Public repo: **https://github.com/Coder-soft/notmoviebox**, branch `main`.
- Commit identity when none configured:
  `Coder-soft <Coder-soft@users.noreply.github.com>`.

## Legal

Unofficial and unaffiliated. It reads the same public API the site itself calls and
does not bypass authentication or payment — it requests exactly the free stream the
site serves to anonymous visitors, and VIP quality requires a real VIP account. For
personal, educational use.
