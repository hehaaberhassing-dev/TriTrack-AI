# Automatic Strava sync — one-time setup

This connects TriTrack to Strava so new runs appear on their own. You do this
**once** (~30 min). After that, just open the app and your latest runs are there.

You'll set up two free things: a **Strava API app** (gives the keys) and a
**Cloudflare Worker** (a tiny backend that holds the secret key safely, since a
plain website isn't allowed to). Everything below is free; the only possible cost
is that Strava may require an active **Strava subscription** to use their API.

---

## Part 1 — Create your Strava API application

1. Go to **https://www.strava.com/settings/api** (log in if needed).
2. Fill in:
   - **Application Name:** `TriTrack`
   - **Category:** `Training` (anything is fine)
   - **Website:** `https://hehaaberhassing-dev.github.io/Tritrack/`
   - **Authorization Callback Domain:** leave as `localhost` **for now** — you'll
     change it in Part 3 once you know your Worker's address.
3. Click **Create**.
4. You now see **Client ID** (a number) and **Client Secret** (a long string).
   Keep this tab open — you'll copy both into Cloudflare next.

---

## Part 2 — Deploy the backend (Cloudflare Worker)

1. Create a free account at **https://dash.cloudflare.com/sign-up**.
2. In the dashboard: left sidebar → **Workers & Pages** → **Create** →
   **Create Worker**.
3. Name it `tritrack-strava` → **Deploy** (it deploys a placeholder).
4. Click **Edit code**. Delete everything in the editor, then paste the entire
   contents of **`worker.js`** (in this project) → **Deploy**.
5. Note your Worker's address, shown at the top — it looks like:
   `https://tritrack-strava.<your-name>.workers.dev`
   **Copy it** — you'll need it twice.

### Add the KV storage (remembers your Strava login)

6. Sidebar → **Workers & Pages** → **KV** → **Create a namespace** →
   name it `TOKENS` → **Add**.
7. Open your **tritrack-strava** Worker → **Settings** → **Bindings** (or
   **Variables**) → **Add binding** → **KV namespace**:
   - **Variable name:** `TOKENS`
   - **KV namespace:** select the `TOKENS` you just made → **Save**.

### Add the secret keys

8. Same Worker → **Settings** → **Variables and Secrets** → add these three
   (use **Encrypt** / "Secret" for the first two):
   - `STRAVA_CLIENT_ID` = your Client ID from Part 1
   - `STRAVA_CLIENT_SECRET` = your Client Secret from Part 1
   - `ALLOWED_ORIGIN` = `https://hehaaberhassing-dev.github.io`  *(origin only —
     no `/Tritrack/` on the end)*
9. **Save and deploy**.

---

## Part 3 — Point Strava back at your Worker

1. Return to **https://www.strava.com/settings/api**.
2. Change **Authorization Callback Domain** to your Worker's host — i.e. your
   Worker address **without** `https://` and **without** any path:
   `tritrack-strava.<your-name>.workers.dev`
3. Click **Update Application**.

---

## Part 4 — Connect in the app

1. Open TriTrack → **Activity** tab → **⤓** → under **Automatic sync**, paste your
   full Worker URL (`https://tritrack-strava.<your-name>.workers.dev`).
2. Tap **Connect Strava** → approve on Strava's screen.
3. You're bounced back to the app and your full run history syncs automatically.

From now on it **auto-syncs every time you open the app** — new runs, updated
predictions and stats, no files. You can also tap **Sync now** anytime.

---

### Troubleshooting

- **"Couldn't sync"** → double-check the Worker URL has no trailing slash, and that
  `ALLOWED_ORIGIN` is exactly `https://hehaaberhassing-dev.github.io`.
- **Strava error on approve** → the Callback Domain (Part 3) must match your Worker
  host exactly (no `https://`, no `/callback`).
- **"refresh failed"** → re-check `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`.
- Your runs are still safe regardless — the file import (same ⤓ screen) always works
  as a fallback.
