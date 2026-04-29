# 🏀 Hoops Bot

A WhatsApp bot that runs your pickup basketball signups. Enforces the 10am-day-before reservation rule, manages a 15-person playing list with auto-waitlist, handles `+1` friends, and reposts the live list every time it changes.

Uses regex first for fast/free classification of obvious "in"/"out" messages, falls back to Claude Haiku 4.5 for fuzzy ones ("yeah throw me on", "can't make it", etc.).

## How it works

- Bot logs into WhatsApp using a dedicated phone number (Baileys, same protocol the WhatsApp Web client uses).
- Watches your group chat for messages.
- 1 minute before signups open: posts a heads-up.
- At exactly 10:00 the day before a game day: posts the open message. Anyone typing "in" before that gets a polite "too early" reply and is **not** counted.
- After 10am: every "in" / "out" / "+1" message updates the list. The bot reposts the full ordered list each time.
- If someone in the playing 15 drops out, the top of the waitlist auto-promotes and the bot announces it.

## Pick your deployment

### Route A: Railway (no server, ~$5/month)

This is the path of least resistance. You'll never SSH into anything.

1. **Get a dedicated WhatsApp number.** Use a spare phone with a prepaid SIM, or a second number on a dual-SIM phone. Don't use your personal number — automating it can get accounts banned. Add this number to your basketball group chat as an admin.

2. **Get an Anthropic API key.** Sign up at https://console.anthropic.com, create a key. Add ~$5 of credits; you'll burn through pennies per month.

3. **Push this code to GitHub.** A private repo is fine.

4. **Create a Railway project.**
   - Go to https://railway.com → New Project → Deploy from GitHub repo → pick this repo.
   - In the project's **Variables** tab, add:
     - `ANTHROPIC_API_KEY` — from step 2
     - `TIMEZONE` — e.g. `America/New_York`
     - `GAME_DAYS` — e.g. `tuesday,thursday`
     - `MAX_PLAYERS` — `15`
     - `OPEN_HOUR` — `10`
     - `OPEN_MINUTE` — `0`
     - Leave `GROUP_JID` blank for now.
   - In **Settings** → **Volumes**, add a volume mounted at `/data`. Then add these env vars:
     - `AUTH_DIR` — `/data/auth`
     - `DATA_DIR` — `/data/db`
   - This is critical — without the volume, the bot loses its WhatsApp login every time Railway redeploys.

5. **First deploy: link the WhatsApp account.**
   - Open the **Deployments** → live logs.
   - You'll see a QR code printed in the logs.
   - On the dedicated WhatsApp phone: Settings → Linked Devices → Link a Device → scan the QR.
   - Logs will show "✅ WhatsApp connected" and then list every group the bot is in, with each group's JID (a string ending in `@g.us`).

6. **Set the group JID.**
   - Find your basketball group in the logs, copy its JID.
   - In Railway → Variables, set `GROUP_JID` to that value.
   - Railway redeploys automatically. The bot is now live.

That's it. The bot will handle Tuesday and Thursday games on its own.

### Route B: DigitalOcean droplet ($5/month, more control)

Same code, your own Linux box.

1. Steps 1–2 from Route A (dedicated number, Anthropic key).

2. Create a $5 DigitalOcean droplet (Ubuntu 24.04, smallest tier). SSH in.

3. Install Docker:
   ```
   curl -fsSL https://get.docker.com | sh
   ```

4. Clone this repo onto the droplet:
   ```
   git clone <your-repo-url> hoops-bot
   cd hoops-bot
   ```

5. Create a `.env` file with your config (copy from `.env.example`).

6. Build and run with a persistent data volume:
   ```
   docker build -t hoops-bot .
   docker run -d --restart=unless-stopped \
     --name hoops-bot \
     --env-file .env \
     -v hoops-data:/data \
     hoops-bot
   ```

7. Watch the logs to scan the QR:
   ```
   docker logs -f hoops-bot
   ```
   Scan the QR with the bot's WhatsApp (Linked Devices). After it connects, copy the group JID from the logs into your `.env`, then:
   ```
   docker restart hoops-bot
   ```

Bot is now live and will auto-restart on crashes or droplet reboots.

## Operating the bot

**Re-linking after WhatsApp logs out** (happens every few weeks). On Railway, redeploy and re-scan from the logs. On Docker, `docker logs -f hoops-bot` and re-scan.

**Changing schedule.** Update the env vars and redeploy/restart.

**Checking who's signed up out of band.** The SQLite DB is at `data/hoops.db` (Route B) or in the `/data` volume (Route A). Standard SQLite tools work.

**Adding a manual signup or removing someone.** Easiest path: have them send "in" / "out" in the group. If the bot is down or you need a manual override, you can edit the `signups` table directly.

## Cost ballpark

- Railway: $5/month
- DigitalOcean: $5/month
- Anthropic API (Claude Haiku 4.5 for ambiguous messages, ~30-50 calls per game × 2 games/week): under $0.50/month at typical volume.

## Heads up about WhatsApp ToS

Using Baileys to automate a personal-style account is technically against WhatsApp's ToS. In practice this is widely done and the risk to the bot's number is low for low-volume, single-group use. Use a dedicated number you don't care about losing — never your personal one.

## Files

- `src/index.js` — main bot, Baileys connection, message routing, cron
- `src/classifier.js` — regex-first hybrid classifier with Claude fallback
- `src/signups.js` — list/waitlist logic
- `src/schedule.js` — figures out next game date and signup-open time
- `src/db.js` — SQLite schema and queries
- `src/config.js` — env var loading
