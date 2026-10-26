# Deploying YouDown on Render (Single Unified Deployment)

**Both Frontend and Backend are packaged together into 1 single Web Service deployment.**
You do **not** need two separate services or two separate URLs.

---

## 🎯 Why Unified Deployment is Best on Render
- **1 Single Service**: Completely stays within Render's free tier limits (750 hours/month).
- **Zero CORS Issues**: Frontend and Backend share the exact same domain and port.
- **Includes External Tools**: The Docker image automatically provisions `python3`, `ffmpeg`, and `yt-dlp`.
- **Automatic SPA Routing**: Deep links like `https://youdown.onrender.com/watch?v=JYyzYnvad50` resolve to the React app automatically.

---

## 🚀 Step-by-Step Deployment (Takes ~3 minutes)

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
