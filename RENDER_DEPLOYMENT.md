# Deploying YouDown on Render (Single Unified Deployment)

> [!NOTE]
> YouTube blocks datacenter IPs like Render's (`Sign in to confirm you're not a bot`). YouDown handles this itself: the image routes YouTube traffic through a free **Cloudflare WARP** tunnel over **IPv4** (see the WARP section below). No proxy or cookies are needed.

---

## 🚫 Limitations & Roadblocks on Render

### 1. YouTube Datacenter IP Ban (Primary Blocker)
YouTube systematically blocks video downloads from cloud hosting data centers:
- `HTTP Error 429: Too Many Requests`
- Bot challenge pages (`Sign in to confirm you’re not a bot`)
- Missing stream formats / PO Token required error
Render routes all outgoing container traffic through its shared datacenter IPs, which YouTube aggressively flags. YouDown avoids this with its built-in WARP tunnel. WARP's IPv6 addresses are flagged too, which is why the tunnel runs IPv4-only.

### 2. Free Tier Resource Limits
- **512 MB RAM**: Video downloading and muxing with `ffmpeg` + `yt-dlp` can quickly spike memory beyond 512 MB, triggering Linux OOM (Out Of Memory) kills.
- **100-Second Gateway Timeout**: Render's ingress proxy drops connections if a video takes longer than 100 seconds to download and process.
- **Sleep after 15 minutes**: Free instances spin down when idle. Waking up takes 50+ seconds, causing initial URL requests to timeout.
- **Ephemeral Storage**: All cached files in `./downloads` are wiped when the service sleeps or restarts.

---

## 🛠️ Environment Variables

Nothing beyond `render.yaml` is required. Optional overrides:

| Variable | Description | Default |
|---|---|---|
| `WARP_ENABLED` | Route YouTube traffic through Cloudflare WARP | `true` in the Docker image |
| `WARP_IP_FAMILY` | `ipv4` tunnels IPv4 only; `dual` also allows IPv6, whose WARP ranges YouTube bot-walls | `ipv4` |
| `WARP_PROFILE_B64` | **Set this.** Fixed WARP identity: base64 of a `wgcf-profile.conf`. Without it every cold start registers a new WARP account, and Cloudflare soon answers `429`, leaving the tunnel down. Secret: dashboard only, never commit | unset |
| `YOUTUBE_PROXY` | Your own HTTP/SOCKS5 proxy; takes precedence over WARP | unset |
| `YOUTUBE_PLAYER_CLIENT` | Override the yt-dlp player client (e.g. `mweb`) | `web_embedded`, then `mweb,tv` |
| `PORT` | HTTP port | `10000` |

> **Recommended Plan**: At least a **Starter** or **Standard** plan (2 GB+ RAM) with a persistent disk if you want file caching.

---

## 🎯 Why Unified Deployment Architecture

If configured with a proxy:
- **1 Single Service**: Frontend and Backend run together inside 1 Docker container.
- **Zero CORS Issues**: Frontend and Backend share the exact same domain and port.
- **Includes External Tools**: The Docker image automatically provisions `python3`, `ffmpeg`, and `yt-dlp`.
- **Automatic SPA Routing**: Deep links like `https://youdown.onrender.com/watch?v=JYyzYnvad50` resolve to the React app automatically.

---

## 🚀 Step-by-Step Deployment Guide

### Option 1: Render Blueprint (Easiest - 1 Click)
1. Push this project to your **GitHub** or **GitLab** account.
2. Go to your [Render Dashboard](https://dashboard.render.com).
3. Click the blue **New +** button in the top right ➔ Select **Blueprint**.
4. Connect your repository.
5. Render will automatically read `render.yaml` and configure the unified `youdown` Web Service.
6. Click **Apply**.
7. Render will build the Docker container (installing Node, Python, FFmpeg, yt-dlp, and compiling both React & NestJS).
8. Once finished, your site will be live at:
   `https://youdown.onrender.com`

---

### Option 2: Manual Web Service
1. In Render Dashboard, click **New +** ➔ **Web Service**.
2. Select your repository.
3. Configure:
   - **Name**: `youdown`
   - **Region**: Oregon (or your preferred region)
   - **Runtime**: **Docker**
   - **Dockerfile Path**: `./Dockerfile`
   - **Instance Type**: **Free**
4. Environment Variables (optional, already defaulted in Dockerfile):
   - `DOWNLOAD_FORMAT`: `mp4`
   - `DOWNLOAD_QUALITY`: `best`
   - `CACHE_RETENTION_MINUTES`: `30`
5. Click **Create Web Service**.

---

## 🌐 Custom Domain (e.g. `youdown.com`)

To use the URL trick on your own domain:
1. In your Render service, go to **Settings** ➔ **Custom Domains**.
2. Add `youdown.com` and `www.youdown.com`.
3. Add the DNS records shown by Render in your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.).
4. Render automatically issues a free SSL certificate.
5. Now, changing `youtube.com/watch?v=...` to `youdown.com/watch?v=...` opens your site and automatically downloads the video!

---

## 🛡️ Free Cloudflare WARP Egress (no proxy or cookies needed)

The Docker image ships `wgcf` + `wireproxy` and starts a userspace Cloudflare WARP tunnel on boot (`WARP_ENABLED=true`). yt-dlp is routed through it via a local SOCKS5 proxy, so YouTube sees a Cloudflare IP instead of Render's datacenter IP. The default yt-dlp client is `web_embedded,mweb,tv`.

- **Fixed identity (`WARP_PROFILE_B64`):** generate once and paste into the dashboard as a secret:
```bash
wgcf register --accept-tos && wgcf generate        # on any machine where registration works
base64 -w0 wgcf-profile.conf                        # PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("wgcf-profile.conf"))
```
  `/api/health` then shows `warp.identity: "env"`, and restarts never call Cloudflare's registration API
- **IPv4 only:** the tunnel drops IPv6 (`WARP_IP_FAMILY=ipv4`). YouTube flags WARP's IPv6 ranges; with dual-stack, 19/20 videos hit the bot wall (2026-11-16)
- **Check status:** `GET /api/health` → `warp.ready`, `warp.warp` (`on`), `warp.ipFamily`, `warp.egressIp` (should be IPv4), `warp.colo`
- **If YouTube still blocks:** the user sees "YouTube is temporarily blocking our server" with a **Try again** button (API: `503`, `code: "YT_BLOCKED"`)
- **Self-healing:** on a bot-wall / 403 / 429 error the service reconnects the tunnel with the same identity and retries once (cooldown: `WARP_ROTATE_COOLDOWN_SECONDS`, default 300). While down, it keeps reconnecting with backoff (30 s up to 5 min)
- **No direct YouTube traffic:** if the tunnel is down, YouTube requests get a retryable `503 YT_BLOCKED` instead of going out from Render's IP (which YouTube always blocks)
- An explicit `YOUTUBE_PROXY` always takes precedence over WARP

### In-browser downloads (no server ffmpeg, no long requests)

`/api/video/info` returns signed, expiring stream tokens (H.264 video + AAC audio, plus a progressive fallback). The browser fetches each stream through `GET /api/video/stream?token=…` in bounded 4 MB `Range` chunks (relayed through WARP, since googlevideo URLs are IP-locked) and muxes them into an MP4 with [mediabunny](https://mediabunny.dev) without re-encoding. If anything fails, it falls back to the classic `/api/video/download` endpoint.

The default yt-dlp client chain is `web_embedded`, then `mweb,tv` if that fails.

See [`docs/WARP_DEPLOYMENT_PLAN.md`](./docs/WARP_DEPLOYMENT_PLAN.md) for the research and roadmap.

---

## 🐦 X (Twitter) Support

The same input box (and the URL trick `x.com/USER/status/ID` → `<your-app>/USER/status/ID`) accepts X post links.

- **Extraction:** yt-dlp tries `twitter:api=graphql` via WARP, then `twitter:api=syndication` via WARP, then `graphql` directly from Render's IP (in case X throttles WARP). The log line `X extraction succeeded via …` shows which one worked.
- **Download:** X's `video.twimg.com` MP4s aren't IP-locked and allow CORS, so the browser fetches them directly (sent without a `Referer`, since X's CDN blocks hotlinking from other sites). The server download endpoint is the fallback.
- **Limits:** protected/age-gated posts, Spaces/broadcasts, and `t.co` short links aren't supported. X changes its guest API often; redeploying pulls the latest yt-dlp.
