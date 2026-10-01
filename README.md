# notmoviebox

A standalone replacement frontend for [themoviebox.xyz](https://themoviebox.xyz)
that keeps every category and plays everything through the
[moviethon](https://github.com/Coder-soft/moviethon) overlay player.

No userscript, no browser extension, no iframes of the original site — it is its
own app that talks to the same public MovieBox BFF API.

```
public/            static SPA (vanilla JS, no build step)
  index.html
  styles.css       app theme + the moviethon player styles
  api.js           API client (token handling, media-proxy URL builder)
  app.js           hash router + views (home, categories, search, detail) + auth
  player.js        moviethon player, adapted to a module
  vendor/          hls.js + dash.js
server/
  index.mjs        zero-dependency Node server: static + API proxy + media proxy
  bridge.mjs       optional Chrome bridge for signed-in sessions
shared/core.js     proxy core (request shaping, HLS/DASH rewriting)
Dockerfile         container image
research/          the original moviethon userscript (reference)
```

## Run

```bash
npm start          # http://127.0.0.1:8787 (auto-bumps the port if busy)
PORT=9000 npm start
```

Node 20+ required. There are no dependencies to install.

Or as a container:

```bash
docker build -t notmoviebox .
docker run -p 8787:8787 notmoviebox
```

## Share on your network

`scripts/share.mjs` binds the server to all interfaces and prints the URLs other
devices can use — LAN and Tailscale:

```bash
npm run share                    # LAN + Tailscale
npm run share -- --port 9000
npm run share -- --no-tailscale  # LAN only
npm run share -- --funnel        # also expose publicly via Tailscale Funnel
./scripts/share.mjs --help
```

Output looks like:

```
notmoviebox sharing

local     http://127.0.0.1:8787/
LAN       http://192.168.1.20:8787/   (en0)
tailnet   http://100.99.82.53:8787/   (Tailscale IP — works on your tailnet)

Ctrl+C to stop.
```

Because the server listens on `0.0.0.0`, the **Tailscale IP works with no extra
setup** — any device on your tailnet can open it. The script additionally *tries*
`tailscale serve` to add HTTPS on your `*.ts.net` name; if the CLI can't (the macOS
GUI build commonly refuses), it says so and you just use the IP URL. `Ctrl+C` stops
the server, and resets `tailscale serve` if it was configured.

Flags: `--port <n>`, `--https-port <n>`, `--funnel`, `--no-tailscale`,
`--keep-serve`.

## CLI

Link the CLI onto your PATH so it runs from anywhere:

```bash
npm run link       # or: npm link   (needs a writable global npm prefix)
npm run unlink
```

`npm run link` tries `npm link` first. If the global npm prefix isn't writable
(common with Homebrew/system Node — `/usr/local/lib/node_modules` is root-owned),
it falls back to symlinking the bin into the first writable directory already on
your PATH, which needs no sudo. It installs two commands:

```bash
notmoviebox              # share on LAN + Tailscale (default)
nmb                      # short alias, same thing
notmoviebox serve        # local only (127.0.0.1)
notmoviebox share --port 9000
notmoviebox serve --port 8080
notmoviebox help
notmoviebox version
```

## Why there is a server

The MovieBox API and its CDN need two things a plain static page cannot do from a
different origin:

1. **Auth.** `/subject/play` and `/subject/search` require a bearer token. The API
   hands out an anonymous token in the `x-user` response header; the server keeps
   one warm and injects it on every `/api/*` call.
2. **Media.** The CDN sends no `Access-Control-Allow-Origin`, HLS/DASH are fetched
   with `fetch`/XHR (so CORS applies), and streams require a `Referer`, a signed
   header (`signHeaderKey`/`signCookie`) and cookies set by a pre-play API. The
   browser cannot set `Referer` at all. `/media?u=…` fetches server-side with the
   right headers and rewrites HLS playlists so every variant/segment/key keeps
   flowing through the proxy.

So `server/index.mjs` is the "no compromises" part: it makes playback work exactly
like it does inside the real site's session.

## Playback

**No account needed, and it plays at 1080p.** The API hands anonymous clients the
same thing it hands the official player:

- a free **MP4** rendition, and
- a **DASH ladder** at **1080 / 720 / 480** (HEVC video + AAC audio).

Two things gate it, both of which the site itself satisfies:

1. **Referer.** The play request must carry
   `Referer: https://themoviebox.xyz/movies/<detailPath>?id=<subjectId>&type=/movie/detail&detailSe=&detailEp=&lang=en`.
   Change it to `/detail/…` (or drop it) and the response comes back with zero
   streams — same token, same URL, only the Referer differs.
2. **Signed header.** The DASH entry ships with `signHeaderKey: "X-MB-Token"` and a
   `signCookie` value. Without that header the CDN returns `403 ACCESS DENIED`; with
   it you get the full 1080p ladder. This is exactly what moviethon does.

The server mirrors both, and the player defaults to the highest-resolution source
available (DASH 1080p), forcing the top rendition and falling back automatically if
a codec can't decode. This is "play the best video the API provides", with no popups
and no ads.

`playConfig.maxResolution: 480` and `vipLocked: true` flags are still present in the
response, but the API also returns the DASH URL and its signed header to anonymous
clients, so the ladder is reachable. Nothing is forged — the app only uses the URLs
and tokens the API itself returns.

### Accounts (optional)

Signing in is entirely optional; it does not change what the free DASH ladder gives
you. If you want it anyway, four methods work:

1. **Browser session** — the server launches a real Chrome with a persistent profile
   and opens `themoviebox.xyz`; session-bound calls run inside that page.
   `~/.notmoviebox/chrome-profile`, auto-discovered Chrome, override with
   `NMB_CHROME=/path/to/chrome`.
2. **Continue with Google** — Firebase popup → `POST /user/google-login`.
3. **QR code** — scan with the MovieBox mobile app (origin-independent).
4. **Paste a session token** — bookmarklet to copy it from `themoviebox.xyz`.

Options 2–4 store the token in `localStorage` and send it as `x-mb-token`; the server
forwards it as `Authorization: Bearer …`.

### How the media proxy works

`/media?u=<b64 url>&h=<header name>&v=<header value>` fetches the CDN resource
server-side with the right Referer/headers/cookies and adds CORS. HLS playlists are
rewritten so every variant/segment/key URI keeps flowing through the proxy. DASH
manifests get a `<BaseURL>` pointing at the path-based form
(`/media/<token>/<relative>`) so dash.js resolves `SegmentTemplate` URLs back through
us while keeping the signed header.

## Categories

All content surfaces of the original site:

| Section | Source |
| --- | --- |
| Home | `/home?host=themoviebox.xyz` (hero banners + rows) |
| Movies | `/subject/filter` `channelId=1` + genre / year / language filters |
| TV Shows | `/subject/filter` `channelId=2` |
| Anime | `/subject/filter` `channelId=4` |
| Midnight | `/tab-operating?tabId=ONEROOM_MIDNIGHT` + `/subject/trending` |
| Top 100 | `/ranking-list/content` (7 curated lists) |
| Search | `/subject/search` + `/subject/everyone-search` suggestions |

Detail pages (`/detail`) show seasons/episodes, related titles
(`/subject/detail-rec`) and a trailer when available.

Every home/tab row that is truncated also has a **View all** link. Rows carry a
`genreTopId`, and `/ranking-list/content?id=<genreTopId>` expands it to the full,
paginated list — the same endpoint the site's own "more" button uses. (The one row
without a `genreTopId`, "Coming Soon", already ships its complete list.)

## Player

`public/player.js` is the moviethon overlay player adapted into a module:

- custom controls — play/pause, seek, volume, speed, PiP, fullscreen
- quality selector (MP4 / HLS / DASH), auto-picks the highest resolution
- season tabs + episode grid with per-episode switching
- single and **dual** subtitles (SRT/ASS → VTT conversion, language preference
  remembered)
- resume position per title in `localStorage`
- keyboard: `space`/`k`, `←`/`→`, `↑`/`↓`, `m`, `f`, `c`, `Esc`

Every stream URL is routed through `/media`, so signed headers, `Referer` and CDN
cookies are applied server-side rather than relying on the browser.

## Performance

Tuned for low-end phones:

- **Thumbnails are downscaled by the CDN.** The originals are enormous — the home
  page references **~205 MB** of artwork, with single covers up to 4.7 MB. Every
  image is requested through
  `?x-oss-process=image/resize,w_320/format,jpg/quality,q_70`, which brings the home
  page to **~7 MB** and a card thumbnail from ~2 MB to ~18 KB. `format,jpg` matters:
  without it OSS re-encodes to PNG and the thumbnail stays ~200 KB.
- **hls.js + dash.js are lazy-loaded.** ~1.2 MB of JS combined, now fetched only
  when you press play instead of blocking every page load.
- **Off-screen content is skipped** via `content-visibility: auto` on rows and
  cards, so the 17-row home page and long grids don't lay out/paint offscreen.
- **`backdrop-filter` is disabled on mobile** — a common cause of scroll jank on
  weak GPUs.
- Images use `loading="lazy"` and `decoding="async"`.

## API endpoints used

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

Base: `https://h5-api.aoneroom.com/wefeed-h5api-bff`

## Legal

Unofficial and unaffiliated. It reads the same public API the site itself calls and
does not bypass authentication or payment — it requests exactly the free stream the
site serves to anonymous visitors, and VIP quality requires a real VIP account. Use
it for personal, educational purposes.
