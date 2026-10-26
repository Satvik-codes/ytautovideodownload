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
- Direct paste in the homepage search box

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

## ☁️ Deploying on Render

See [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md) for full instructions:
1. Push to GitHub.
2. Go to Render ➔ **New +** ➔ **Blueprint**.
3. Select this repo. Render builds the unified Docker container and launches your site!
