# AI Coach — one-time setup (~10 min)

The **Coach** tab works out of the box: without any setup it uses the built-in
coach engine (offline, instant, free) to build a periodized plan from your goal,
timeline, days per week and injuries.

Connecting the **Claude AI backend** upgrades it: Claude actually *reads* your
injury descriptions and free-text notes ("goal time 3:45", "no pool on
weekdays", "coming back from a stress fracture") and writes a plan around them.

It runs on the **same Cloudflare Worker as Strava sync** — one backend for both.

---

## Part 1 — Deploy (or update) the Worker

If you already did STRAVA-SETUP.md:

1. Open **https://dash.cloudflare.com** → **Workers & Pages** → your
   `tritrack-strava` worker → **Edit code**.
2. Replace everything with the current contents of **`worker.js`** (it now has
   the `/ai-plan` endpoint) → **Deploy**.

If you haven't set up the worker yet, follow **Part 2 of STRAVA-SETUP.md**
first (you can skip the Strava keys if you only want the AI coach).

## Part 2 — Add your Anthropic API key

1. Create an account at **https://console.anthropic.com** and add a small
   amount of credit (plans cost a few cents each — see costs below).
2. In the console: **API Keys** → **Create Key** → copy it (starts with
   `sk-ant-`).
3. In Cloudflare: your Worker → **Settings** → **Variables and Secrets** →
   **Add** → type **Secret**:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key
4. **Save and deploy**.

> Optional: add a plain variable `AI_MODEL` to pick a different Claude model.
> Default is `claude-sonnet-4-6` (great plans). `claude-haiku-4-5-20251001`
> is cheaper and faster, slightly less nuanced.

## Part 3 — Connect in the app

1. Open TriTrack → **Coach** tab → **⚙** (top right).
2. Paste your Worker URL (`https://tritrack-strava.<your-name>.workers.dev`) →
   **Save**.
3. The footer under **✨ Build My Plan** now says *"Engine: Claude AI via your
   backend"*. Generate away.

If the backend is ever unreachable, the app automatically falls back to the
built-in coach engine, so plan generation never breaks.

---

## Costs & privacy

- Each generated plan is one Claude API call: roughly **$0.05–0.25** with
  Sonnet depending on plan length (a few cents with Haiku).
- Only what you type into the Coach form (goal, weeks, days, level, fitness
  numbers, injuries, notes) is sent to your worker and on to the Anthropic API.
  Your training history, Strava data and everything else never leave your
  device.
- The `ANTHROPIC_API_KEY` lives only in Cloudflare as an encrypted secret —
  it is never in the app, the repo, or the browser.
- `ALLOWED_ORIGIN` (from STRAVA-SETUP.md) also protects this endpoint's CORS,
  so other websites can't spend your credits from a browser.

## Troubleshooting

- **"AI not configured"** → the `ANTHROPIC_API_KEY` secret is missing on the
  worker, or you didn't redeploy after adding it.
- **"AI request failed (HTTP 401)"** → the key is wrong or revoked.
- **"AI request failed (HTTP 400/429)"** → out of credit or rate-limited —
  check console.anthropic.com → Billing.
- **"AI backend didn't answer … built-in coach stepped in"** → the app still
  gave you a plan; fix the worker URL in ⚙ or the items above, then rebuild.
