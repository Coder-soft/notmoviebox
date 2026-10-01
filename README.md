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
server/index.mjs   zero-dependency Node server: static + API proxy + media proxy
research/          the original moviethon userscript (reference)
```

## Run

```bash
npm start          # http://127.0.0.1:8787 (auto-bumps the port if busy)
PORT=9000 npm start
```

Node 20+ required. There are no dependencies to install.

## Deploy to Cloudflare Workers

```bash
npx wrangler deploy        # or: npm run worker:deploy
npx wrangler dev           # local Workers runtime
```

`wrangler.jsonc` binds `./public` as static assets (`env.ASSETS`) and runs
`worker/index.js` for `/api/*`, `/media*` and `/health`. The shared proxy logic
lives in `shared/core.js`, used by both the Worker and the Node server, so the two
behave identically.

### ⚠️ The MovieBox API blocks Cloudflare egress

This is the important caveat. **`h5-api.aoneroom.com` (and every mirror —
`themoviebox.xyz`, `netfilm.world`, `123movienow.cc`, `movieboxhd.net`) returns
`429 RESOURCE_EXHAUSTED` to requests originating from Cloudflare.**

I verified it: from the deployed Worker, every endpoint — including the plain
`/country-code` warm-up — comes back 429, with and without `Authorization` /
`X-Client-Token` headers, while the same requests succeed from a normal residential
IP. It is IP/ASN based, not header based.

Consequence: the **static UI deploys and works on Workers**, but the API + media
proxy cannot run there — playback won't work from a pure Worker deploy.

### The hybrid setup (recommended)

Keep the UI on Workers and point it at a proxy that *can* reach the API. The
frontend reads `<meta name="proxy-base">` and sends all `/api` and `/media`
requests there:

```html
<!-- public/index.html -->
<meta name="proxy-base" content="https://your-proxy.example.com" />
```

Any of these can serve as the proxy:

- the included Node server (`npm start`) — works from a residential IP;
- the Node server exposed through a **Cloudflare Tunnel**
  (`cloudflared tunnel --url http://localhost:8787`), which keeps the API call on
  your machine;
- any VPS/host whose IP is not blocked by the API.

Rewritten HLS/DASH URLs are absolute (built from the proxy's own origin, honouring
`X-Forwarded-Proto`/`X-Forwarded-Host`), so a proxy on a different origin than the
page works correctly.

If you don't want the hybrid, just run everything locally with `npm start` — that
path is fully working today.

## Free hosting options

The proxy must run somewhere the API/CDN will answer (i.e. not Cloudflare). Ranked
by "free and actually works":

| Option | Free? | Always on? | Notes |
| --- | --- | --- | --- |
| **Your machine + Cloudflare Tunnel** | ✅ | only while on | `./scripts/tunnel.sh` — residential IP, known to work. Zero cost. |
| **Oracle Cloud Always Free** | ✅ forever | ✅ | 4 ARM cores / 24 GB RAM (or 2 AMD micro). Full VM, run the container/Node. |
| **Google Cloud Always Free e2-micro** | ✅ forever | ✅ | 1 vCPU / 1 GB in `us-central1`/`us-west1`/`us-east1`. |
| **Google Cloud Run** | ✅ free tier | scale-to-zero | Container; free monthly request/CPU allowance. |
| **Render (free web service)** | ✅ | ❌ sleeps | Spins down after 15 min idle; ~30–60s cold start; 100 GB/mo egress. |
| **Hugging Face Spaces (Docker)** | ✅ | ❌ sleeps | 2 vCPU / 16 GB; sleeps after 48 h idle; not intended for proxying. |
| **Koyeb free** | ✅ | scale-to-zero | One small service. |
| **Vercel / Netlify free** | ✅ | ✅ | Static UI only — functions can't stream video (size/duration limits). Use with the hybrid `proxy-base`. |
| **Cloudflare Pages/Workers** | ✅ | ✅ | Static UI only — the API 429s Cloudflare egress. |
| ~~Fly.io / Railway / Glitch / Deta~~ | ❌ | — | Free tiers removed/shut down. |

### Container image

`Dockerfile` builds the whole app (server + static assets, no dependencies):

```bash
docker build -t notmoviebox .
docker run -p 8787:8787 notmoviebox
```

Deploy that image anywhere that runs containers (Oracle Cloud, Cloud Run, Render,
Koyeb, HF Spaces, a VPS). It sets `HOST=0.0.0.0` and honours `PORT`.

### Verifying a host isn't blocked

Before wiring anything up, check the API answers from that host:

```bash
curl https://YOUR-HOST/api/country-code
# {"code":0,...,"data":{"countryCode":"PK"}}  -> good
# {"code":429,"reason":"RESOURCE_EXHAUSTED"}  -> that host's IP is blocked
```

## Why there is a server

The MovieBox API and its CDN need two things a plain static page cannot do from a
different origin:

1. **Auth.** `/subject/play` and `/subject/search` require a bearer token. The API
   hands out an anonymous token in the `x-user` response header; the server keeps
   one warm and injects it on every `/api/*` call.
2. **Media.** The CDN sends no `Access-Control-Allow-Origin`, HLS/DASH are fetched
   with `fetch`/XHR (so CORS applies), and streams can require a `Referer`, a
   signed header (`signHeaderKey`/`signCookie`) and cookies set by a pre-play API.
   The browser cannot set `Referer` at all. `/media?u=…` fetches server-side with
   the right headers and rewrites HLS playlists so every variant/segment/key keeps
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

## Player

`public/player.js` is the moviethon overlay player adapted into a module:

- custom controls — play/pause, seek, volume, speed, PiP, fullscreen
- quality selector (MP4 / HLS / DASH), auto-picks a sane default
- season tabs + episode grid with per-episode switching
- single and **dual** subtitles (SRT/ASS → VTT conversion, language preference
  remembered)
- resume position per title in `localStorage`
- keyboard: `space`/`k`, `←`/`→`, `↑`/`↓`, `m`, `f`, `c`, `Esc`

Every stream URL is routed through `/media`, so signed headers, `Referer` and CDN
cookies are applied server-side rather than relying on the browser.

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
