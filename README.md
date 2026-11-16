# YouDown - Instant One-Click YouTube Downloader (Unified Deployment)

An automated YouTube video downloader inspired by `yout.com`. Built with a **React** (light-mode white & blue) frontend and a **NestJS** backend, packaged as a **single unified deployment**.

---

## ⚡ The URL Magic Trick

Just like deleting "ube" in `yout.com`, YouDown lets you download videos directly from your browser's address bar:

1. **While watching any video on YouTube**:
   `https://www.youtube.com/watch?v=JYyzYnvad50`
2. **Change "youtube" to "youdown"** (or in local dev, `localhost:3000/watch?v=JYyzYnvad50`):
   `https://www.youdown.com/watch?v=JYyzYnvad50`
3. **Hit Enter**:
   The website opens, recognizes the video metadata, and **immediately begins downloading the video file automatically** with zero settings required!

### Supported URL Patterns:
- `/watch?v=VIDEO_ID` (Standard YouTube watch URL replacement)
- `/video?url=https://www.youtube.com/watch?v=...` (yout.com style)
- `/shorts/VIDEO_ID` (YouTube Shorts)
- `/?v=VIDEO_ID`
- `/USER/status/POST_ID` (X / Twitter: swap `x.com` for your YouDown address)
- Direct paste in the homepage search box (YouTube or X links)

### X (Twitter) Videos
Paste any public `x.com` / `twitter.com` post link (mobile, `fxtwitter`/`vxtwitter` mirrors and `/video/2` clip selection are supported). X serves ready-made H.264 MP4s that are neither signed nor IP-locked, so the server only fetches metadata and **the browser downloads the file straight from X's CDN**. No relay or muxing is needed. Not supported: protected or age-gated posts, Spaces/broadcasts, and `t.co` short links (paste the full post link instead).

---

## 📦 Single Unified Deployment Architecture

Both frontend and backend run together from **one single deployment**:
- **Single Port & Domain**: No CORS setup or separate domains required.
- **Frontend**: React 19 + TypeScript + Vite, served by NestJS via `@nestjs/serve-static`.
- **Backend**: NestJS, handles `/api/video/*` endpoints and streams video files with `yt-dlp` and `ffmpeg`.
- **Render Ready**: Includes multi-stage [`Dockerfile`](./Dockerfile) and [`render.yaml`](./render.yaml).

---

## ⚙️ Backend Configuration (`backend/.env`)

All videos downloaded through the service share uniform settings configured centrally in `backend/.env`:

```env
# Server Port & CORS
PORT=3000

# Uniform Download Settings (applied automatically to all downloads)
DOWNLOAD_FORMAT=mp4       # Options: mp4 | mp3 | m4a | webm
DOWNLOAD_QUALITY=best     # Options: best | 1080p | 720p | 480p

# Storage & Safety Limits
DOWNLOAD_STORAGE_DIR=./downloads
CACHE_RETENTION_MINUTES=30
MAX_VIDEO_DURATION_SECONDS=10800
MAX_CONCURRENT_DOWNLOADS=5
```

---

## 🚀 Running Locally

### Option 1: Unified Mode (Frontend + Backend on `http://localhost:3000`)
```bash
# 1. Build frontend and backend
npm run build

# 2. Start unified server
npm start
```
Open **`http://localhost:3000`** — both the React UI and API run on port 3000!

### Option 2: Dev Mode (Hot-Reload)
- Backend: `cd backend && npm run start:dev` (runs on `http://localhost:3000`)
- Frontend: `cd frontend && npm run dev` (runs on `http://localhost:5173` with proxy to backend)

---

## ⚠️ Limitations & Why Cloud Hosting (Render, Heroku, AWS) Fails

Running a YouTube downloader on cloud platforms like **Render**, **Heroku**, or standard **AWS/DigitalOcean** instances faces severe hurdles and generally **does not work reliably out-of-the-box**:

### 1. 🚫 Datacenter IP Blacklisting (The Main Blocker)
- **YouTube actively blocks datacenter IP ranges**: Google maintains an aggressive blocklist against IPs belonging to cloud providers (Render, AWS, DigitalOcean, Hetzner, OVH, etc.).
- When requests originate from Render’s IP pool, YouTube responds with:
  - `HTTP Error 429: Too Many Requests`
  - `Sign in to confirm you’re not a bot`
  - Mandatory **PO Tokens (Proof of Origin)** and bot challenge scripts that cannot be solved headless on datacenter IPs without a residential proxy.
- **How YouDown handles it:** YouTube traffic goes through a free Cloudflare **WARP** tunnel running **IPv4-only** (WARP's IPv6 ranges are bot-walled too). See [`docs/WARP_DEPLOYMENT_PLAN.md`](./docs/WARP_DEPLOYMENT_PLAN.md).

### 2. ⏳ Render Free Tier Sleep & Cold Starts
- Render's free tier spins down web services after 15 minutes of inactivity.
- Waking up takes **50+ seconds**. When a user uses the URL trick (`youdown.com/watch?v=...`), the browser request will either time out or abandon the download before the container even starts.

### 3. 💥 Memory Limits (512 MB RAM OOM Killer)
- Merging high-resolution video and audio streams (`ffmpeg` + `yt-dlp` + NestJS runtime) requires significant buffer memory.
- On Render's 512 MB free tier, large or 1080p+ video processing triggers the Linux kernel **Out-Of-Memory (OOM) killer**, terminating the server mid-download.

### 4. ⏱️ 100-Second Gateway Timeout
- Render’s reverse proxy terminates any HTTP request that does not finish or stream within **100 seconds**.
- Long videos or slower downloads will abruptly fail with `502 Bad Gateway` or `504 Gateway Timeout`.

### 5. 💾 Ephemeral Disk Storage
- Render containers do not have persistent disks on the free tier. All cached downloads and temporary chunks are lost whenever the service redeploys or restarts.

---

## 🛠️ How to Make Cloud Deployment Work (Workarounds)

The Docker image already does what's needed on Render's free tier, with no proxy or cookies:

1. **Cloudflare WARP egress (IPv4)**: built in and on by default (`WARP_ENABLED=true`, `WARP_IP_FAMILY=ipv4`). Check `GET /api/health`: `warp.egressIp` should be an IPv4 address.
2. **In-browser muxing**: video and audio are relayed in small chunks and muxed in the browser, so the server never runs a big ffmpeg merge.
3. **Optional:** `YOUTUBE_PROXY` (your own proxy) still overrides WARP. The project's decision is to stay free, with no paid proxies or cookies.

> **💡 Recommended Setup**: Run YouDown **locally** on your own computer, home server, or Raspberry Pi where your residential IP is accepted by YouTube without proxies or cookies.

---

## ☁️ Deploying on Render

See [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md) for full instructions and environment variables.
