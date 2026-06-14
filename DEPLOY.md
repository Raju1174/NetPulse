# Deploying NetPulse online (free) — Render

NetPulse is a Node.js server, so it needs a host that runs Node (not GitHub
Pages). **Render's free Web Service** runs it with no code changes and gives you
a public `https://<name>.onrender.com` link.

> Free-tier note: the service **sleeps after 15 min of inactivity**. The first
> visit after that takes ~30–50s to wake up. Open the link a minute before a
> demo/viva and it stays warm.

---

## Step 1 — Put the code on GitHub

1. Create a free account at <https://github.com> (if you don't have one).
2. Create a new **empty** repository, e.g. `netpulse-demo` (no README/.gitignore —
   this folder already has them).
3. In a terminal **inside the `Demo` folder**, run:

   ```bash
   git init
   git add .
   git commit -m "NetPulse demo"
   git branch -M main
   git remote add origin https://github.com/<your-username>/netpulse-demo.git
   git push -u origin main
   ```

   (In Claude Code you can prefix each line with `! ` to run it here, e.g.
   `! git init`.)

## Step 2 — Deploy on Render

1. Sign up free at <https://render.com> (use "Sign in with GitHub" — easiest).
2. Click **New +  →  Web Service**.
3. Connect your `netpulse-demo` GitHub repo.
4. Render auto-detects the settings from `render.yaml` (or set manually):
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Click **Create Web Service**. First build takes ~1–2 minutes.
6. When it says *Live*, open the URL at the top — that's your public NetPulse. ✅

## Updating later

Any time you change the code, just:

```bash
git add .
git commit -m "update"
git push
```

Render rebuilds and redeploys automatically.

---

## Alternative — instant share without an account (temporary)

If you only need to show it briefly from your own running laptop, use a tunnel
instead of hosting:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints a temporary public `https://...trycloudflare.com` link that works as
long as your PC and the server (`start.bat`) are running. Good for a quick share;
not a permanent host.
