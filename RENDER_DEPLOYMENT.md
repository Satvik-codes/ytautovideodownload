# Deploying YouDown on Render (Single Unified Deployment)

> [!WARNING]
> **Read Before Deploying to Render**:
> YouTube strictly blacklists IP addresses belonging to datacenter hosting providers (Render, AWS, DigitalOcean, etc.). Deploying YouDown directly to Render on the Free Tier **will fail** with `429 Too Many Requests` or `Sign in to confirm you're not a bot` unless you configure a **Residential Proxy** or provide **YouTube Cookies**.
>
> Please read the [Limitations & Roadblocks on Render](#-limitations--roadblocks-on-render) section below before deploying.

---

## 🚫 Limitations & Roadblocks on Render

### 1. YouTube Datacenter IP Ban (Primary Blocker)
YouTube systematically blocks video downloads from cloud hosting data centers:
- `HTTP Error 429: Too Many Requests`
- Bot challenge pages (`Sign in to confirm you’re not a bot`)
- Missing stream formats / PO Token required error
Render routes all outgoing container traffic through its shared datacenter IPs, which YouTube aggressively flags.

### 2. Free Tier Resource Limits
- **512 MB RAM**: Video downloading and muxing with `ffmpeg` + `yt-dlp` can quickly spike memory beyond 512 MB, triggering Linux OOM (Out Of Memory) kills.
- **100-Second Gateway Timeout**: Render's ingress proxy drops connections if a video takes longer than 100 seconds to download and process.
- **Sleep after 15 minutes**: Free instances spin down when idle. Waking up takes 50+ seconds, causing initial URL requests to timeout.
- **Ephemeral Storage**: All cached files in `./downloads` are wiped when the service sleeps or restarts.

---

## 🛠️ Mandatory Requirements for Cloud Deployment

To successfully run YouDown on Render, configure the following environment variables in the Render Dashboard:

| Variable | Description | Required? |
|---|---|---|
| `YOUTUBE_PROXY` | HTTP/SOCKS5 Residential Proxy (e.g. `http://user:pass@res-proxy.com:8080`) | **Required** on cloud datacenters |
| `YOUTUBE_COOKIES` | Netscape format cookies exported from a logged-in residential browser session | Strongly recommended |
| `YOUTUBE_PLAYER_CLIENT` | Override player client if needed (e.g. `android` or `mweb`) | Optional |
| `PORT` | Set to `3000` | Handled automatically |

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

- **Check status:** `GET /api/health` → `warp.ready`, `warp.warp` (`on`), `warp.egressIp`, `warp.colo`
- **Self-healing:** on a bot-wall / 403 / 429 error the service registers a new WARP identity and retries once (cooldown: `WARP_ROTATE_COOLDOWN_SECONDS`, default 300)
- **Fallback:** if the tunnel can't come up, the app still runs and connects directly
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
