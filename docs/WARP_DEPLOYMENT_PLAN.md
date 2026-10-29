# YouDown on Render Free: Cloudflare WARP egress + scale patterns

> Saved 2026-10-28 for future reference. Status: **plan only, nothing implemented yet.**

## Context
YouTube blocks Render's datacenter IPs ("Sign in to confirm you're not a bot"). Cookies and paid proxies are ruled out, so the chosen egress is **Cloudflare WARP** (free forever, via `wgcf` + `wireproxy`). The plan also borrows patterns from existing downloader sites that fit Render free: 512 MB RAM, 100 s request timeout, sleeps after 15 min idle.

### What wgcf / WARP are
- **wgcf** (github.com/ViRb3/wgcf) is an unofficial CLI. It registers a free WARP account through Cloudflare's API and exports it as a standard WireGuard config.
- **wireproxy** runs that config in userspace (no root, no TUN device, which Render needs) and exposes a local SOCKS5 proxy for yt-dlp.
- **Cost:** the basic WARP tier is free with no data cap. WARP+ is paid but not needed.
- **Caveats:** wgcf is unofficial and can break if Cloudflare changes its API. WARP's terms target personal devices, so server use is a gray area. Frequent new registrations may be rate-limited.

---

## Reverse-engineering findings (REA + Chrome DevTools, 2026-10-28)

**Target:** vidpickr.com, a production YouTube downloader (several thousand downloads/day per its own blog). It was analysed with `npx rea-agents analyze-web-bundle` against a headless Chrome over CDP. Network traffic of one download page was captured and the shipped JS bundles statically inspected. Analysis was passive only; nothing was downloaded through their service.

| # | Finding | Evidence |
|---|---|---|
| 1 | **Stack:** Next.js frontend on `vidpickr.com`, separate download API on `dl.vidpickr.com` | REA vendor fingerprints; network capture |
| 2 | **Info call:** `GET dl.vidpickr.com/api/info?url=<yt url>` returns title, duration, `resolutions[]` (2160p→240p), `audio_tracks[]` (multi-language dubs), `subtitles[]`, each with a `download_token` | Captured response shape |
| 3 | **Anti-abuse:** the info API requires a browser session cookie and otherwise answers `403 verification required` with header `X-Verification-Required: session`. The site is fronted by a Cloudflare challenge script | Direct fetch failed; header handling seen in the download-page chunk |
| 4 | **Token format:** `base64url(JSON).<43-char HMAC>`. The JSON holds the raw googlevideo URLs (`v` video, `a` audio), filename, source page and an expiry. It is signed so clients can't forge or alter URLs | Decoded token structure (2 segments) |
| 5 | **YouTube client used: `WEB_EMBEDDED_PLAYER`** (`c=` param in the stream URLs). That is yt-dlp's `web_embedded` client, the embedded-player client, which YouTube checks less strictly for embeddable videos | `c=WEB_EMBEDDED_PLAYER` on every stream URL |
| 6 | **Stream URLs are IP-locked:** every googlevideo URL carries `ip=`, so the browser **cannot** download directly from Google's CDN | `ip` param present |
| 7 | **The extraction IP is a small Polish VPS, not residential:** the `ip=` value equals the IP of `dl.vidpickr.com` (AS202520 SkyPass Solutions / skillhost.pl, Warsaw). One cheap VPS on a little-known hosting network does both extraction and relay | ipinfo lookup of both IPs: same address |
| 8 | **Bytes are relayed, not merged, on the server:** the browser calls `dl.vidpickr.com/api/stream?token=…` separately for video and audio. It muxes them **in the browser** (MP4 muxer + mp4box-style parsing) and writes straight to disk via the **File System Access API** (`showSaveFilePicker` → `FileSystemWritableFileStream`) | Download-page chunk: endpoint builder for `stream` / `merge_clip` / `hls`, muxer, writable-stream target |
| 9 | **Extras:** server-side clip endpoint (`/api/clip`), dead-video reporting, a browser extension, paid tier | Route inventory |

**Note:** VidPickr's blog says bytes go "CDN → user". The live code shows that is **not** what happens now. Bytes are relayed through their own server, because the URLs are IP-locked.

### What this means for YouDown
1. **A datacenter IP can work.** VidPickr extracts from a non-residential VPS. The levers are (a) the **`web_embedded` client** and (b) an IP on a less-abused network. WARP gives us (b) for free. Their blog mentions cookies, which we can't confirm or rule out from the client side.
2. **Direct CDN → browser is impossible** (IP-locked URLs). The server must relay, but it should **pipe** bytes, never buffer or merge them.
3. **Moving the merge to the browser** removes ffmpeg from the server. That's the biggest fix for the 512 MB limit.
4. **Signed, expiring tokens** let the server stay stateless: no cache of URLs, and restarts are harmless.

---

## Plan

### Step 0: Feasibility spike (do first, ~30 min, local Docker)
- Throwaway container with `wgcf` + `wireproxy`, then `yt-dlp -v --proxy socks5://127.0.0.1:40000 --extractor-args "youtube:player_client=web_embedded" <url>`. Also try `mweb`, `tv`, and `--force-ipv4` / `--force-ipv6`.
- Confirm `curl --socks5 127.0.0.1:40000 https://www.cloudflare.com/cdn-cgi/trace` reports `warp=on`.
- **Go/no-go:** if every client gets the bot wall through WARP, stop and revisit.

### Step 1: WARP egress inside the container
- `Dockerfile` runner stage: add pinned `wgcf` and `wireproxy` Linux binaries.
- New `docker/start.sh` entrypoint:
  1. `wgcf register --accept-tos && wgcf generate`
  2. Write the wireproxy config with `[Socks5] BindAddress = 127.0.0.1:40000`
  3. Start wireproxy in the background, wait for the port, then `exec node dist/main.js`
- Set `YOUTUBE_PROXY=socks5://127.0.0.1:40000`. Routing needs no code change: `getBaseYtDlpArgs()` already reads it (`backend/src/downloader/downloader.service.ts:99`).

### Step 2: Client choice + PO tokens
- Default `YOUTUBE_EXTRACTOR_ARGS=youtube:player_client=web_embedded,mweb,tv` (finding 5). Uses the existing hook at `downloader.service.ts:69-75`.
- Add the `bgutil-ytdlp-pot-provider` plugin and its token server on `127.0.0.1:4416`, also routed through WARP, since tokens are IP-bound. Keep `--js-runtimes node`.

### Step 3: Self-healing IP rotation
- Detect bot-wall/403/429 in the existing stderr parsing (`downloader.service.ts:144`, `:262`).
- New `WarpService.rotate()` re-registers wgcf and restarts wireproxy (new WARP identity), then retries once. Rate-limit rotations.

### Step 4: VidPickr-style relay + browser muxing (replaces server ffmpeg merge)
- `GET /api/video/info` also returns video+audio formats, each with a **signed token**: `base64url(JSON{url, exp, filename}).HMAC-SHA256`, with the secret in env. Use `--dump-json` `formats` from the existing `getVideoInfo` call.
- New `GET /api/video/stream?token=` verifies the HMAC and expiry. It forwards the browser's `Range` header to googlevideo **through the WARP SOCKS proxy** and pipes the response (no disk, no buffering). Use `undici` + `socks` agent or `fetch` with a SOCKS dispatcher.
- Frontend fetches video and audio in ranged chunks (e.g. 8–10 MB each, keeping every request well under 100 s). It muxes with `mp4-muxer` (or `mediabunny`) and writes via File System Access API where supported, falling back to Blob + `<a download>` for small files. Progressive formats skip muxing.
- Keep the current `downloadVideo` (yt-dlp + ffmpeg to disk) only as a fallback for mp3/m4a conversion.

### Step 5: Caching and limits
- In-memory LRU for `getVideoInfo` keyed by video ID, TTL ~5 h (googlevideo URLs expire ~6 h).
- Remove the repeated `quickGetTitle` YouTube calls (`downloader.service.ts:226, 289`). The title comes from cache or the token.
- `render.yaml`: `MAX_CONCURRENT_DOWNLOADS=2`.

### Step 6: Cold start
- Add `/api/health` and optionally a free external pinger every 10 min. One service running 24/7 is about 744 h, which fits the 750 free hours/month.

## Files to change
- `Dockerfile`, `docker/start.sh` (new), `render.yaml`
- `backend/src/downloader/downloader.service.ts`: formats + tokens, error detection/retry, cache, remove title re-fetches
- `backend/src/downloader/warp.service.ts` (new), `stream.controller` / extend `downloader.controller.ts`: `/stream` relay, `/health`
- `backend/src/downloader/utils/stream-token.ts` (new): HMAC sign/verify
- Frontend: ranged fetch + mux + save
- `README.md`, `RENDER_DEPLOYMENT.md`, `backend/.env.example`: WARP instead of proxy/cookies; new `STREAM_TOKEN_SECRET`

## Verification
1. `docker build -t youdown . && docker run -p 10000:10000 youdown`. Logs show WARP registered, wireproxy up, bgutil up.
2. Inside the container, WARP trace shows `warp=on`.
3. `/api/video/info?v=JYyzYnvad50` returns formats + tokens. Tampering one token character gives 403. An expired token gives 403.
4. Browser download of a 3-min and a 20-min video completes, plays with audio, and no single `/stream` request exceeds ~30 s.
5. Unit tests: token sign/verify, bot-error → rotation trigger.
6. Deploy to Render free, repeat 3–4, and watch memory stay under 512 MB in Render metrics.

## Tooling notes
- REA: `npx -y rea-agents@6.8.0 analyze-web-bundle <cdp-endpoint> <targetId> --format json`. Needs Chrome launched with `--remote-debugging-port`. It warns about Node engine `^22.23.4 || ^24.22.1` (local is 24.14.0) but ran fine.
- To use REA as an MCP server inside Claude Code: `npx rea-agents setup` (interactive), then restart.
