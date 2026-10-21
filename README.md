# Brief breaking news alerts

Checks about 15 major news outlets every 5 minutes. When 4 or more of them
publish the same story within 90 minutes, the AI rates how big it is (1-10).
If it's a 7 or higher, you get an alert with the headline, a short summary,
which outlets are covering it (with links), and a video hook idea.

## 1. Pick where alerts go (one or both)

**Discord (best for a team):** make a server with a channel like #breaking,
then go to the channel's Settings > Integrations > Webhooks > New Webhook >
Copy Webhook URL. Invite Gustavo and your co-founder.

**Phone (ntfy):** install the free ntfy app, tap +, and subscribe to a topic
with a hard-to-guess name like `brief-breaking-7x92k`. Anyone who knows the
name can read it, so don't use something simple.

## 2. Run it for free with GitHub Actions

1. Make a new **public** GitHub repository (public repos get unlimited free
   Actions minutes; a private one would run out of free minutes at every 5 min).
2. Upload `breaking-alerts.js` and the `.github/workflows/breaking-alerts.yml`
   file, keeping that folder path exactly.
3. In the repo go to Settings > Secrets and variables > Actions > New repository
   secret, and add whichever you use:
   - `DISCORD_WEBHOOK_URL`
   - `NTFY_TOPIC`
   - `GROQ_API_KEY` (your Groq key)
   Secrets stay private even in a public repo. Never paste keys into the code.
4. Go to the Actions tab, open "Brief breaking news alerts" and click
   "Run workflow" to test it. After that it runs by itself every 5 minutes.

Notes: GitHub sometimes runs scheduled jobs a few minutes late. It also pauses
schedules in public repos with no activity for 60 days, so make a small commit
now and then (or re-enable it in the Actions tab).

## Test your setup

On your own computer (Node 18+):

    DISCORD_WEBHOOK_URL=... NTFY_TOPIC=... node breaking-alerts.js --test

`--dry` shows what it would alert without sending anything.

## Tuning

Too many alerts: raise `MIN_SCORE` to 8 or `MIN_OUTLETS` to 5.
Missing stories: lower `MIN_OUTLETS` to 3.
Set these as extra lines under `env:` in the workflow file.
