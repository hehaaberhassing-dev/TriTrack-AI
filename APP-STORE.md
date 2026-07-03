# Getting TriTrack onto phones — from "installable today" to the App Store

There are two levels. Level 1 works **right now, from this Windows PC, for
free**. Level 2 is the real Apple App Store, and Apple's rules make a Mac and a
paid developer account unavoidable — no tool can route around that.

---

## Level 1 — Installable app on any phone, today (PWA)

TriTrack is now a **Progressive Web App**: it has an app icon, runs fullscreen
without browser chrome, and works completely offline after the first visit.

1. Host the folder anywhere static — you already use **GitHub Pages**
   (`https://hehaaberhassing-dev.github.io/Tritrack/`). Just push the updated
   files.
2. On the phone, open that URL once:
   - **iPhone (Safari):** Share button → **Add to Home Screen** → Add.
   - **Android (Chrome):** the **Install app** prompt appears automatically
     (or ⋮ menu → *Add to home screen*).
3. Done. It launches from the home screen like any app, fullscreen, offline,
   with its own icon. Data stays in that phone's storage per the usual rules.

This is how you let friends "download" it today: send them the link, they tap
*Add to Home Screen*. No store review, no fees, updates ship the moment you
push to GitHub.

---

## Level 2 — The real Apple App Store

**What Apple requires, no exceptions:**

| Requirement | Cost |
|---|---|
| Apple Developer Program membership | $99 / year |
| A Mac with Xcode to build & sign (or a cloud Mac) | free–$50/mo |

You cannot build or submit an iOS app from Windows alone. Your options for the
Mac part, cheapest first:

1. **Borrow a Mac** for an afternoon (friend, school, library) — building and
   submitting is a few hours of work.
2. **Cloud CI that provides Macs** — [Codemagic](https://codemagic.io) has a
   free tier with macOS build machines and can build, sign and upload to App
   Store Connect from a GitHub repo, so you never touch a Mac yourself.
3. **Rent a cloud Mac** — MacinCloud / MacStadium, hourly plans.

### The steps (when you have Mac access)

TriTrack wraps cleanly with **Capacitor** because it's already a self-contained
static web app:

```bash
# 1. In the tritrack-web folder (Node.js installed):
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "TriTrack" "com.yourname.tritrack" --web-dir .

# 2. Add the iOS project (on the Mac / CI):
npx cap add ios
npx cap sync ios

# 3. Open in Xcode, set your signing team, build:
npx cap open ios
```

Then in **App Store Connect** (appstoreconnect.apple.com): create the app
record, upload the build from Xcode (Product → Archive → Distribute), fill in
screenshots + privacy info ("data not collected" — everything is on-device),
and submit for review.

### One honest warning — Apple guideline 4.2

Apple sometimes rejects apps that are "just a website in a wrapper". To be
safe, when you wrap it, add a couple of native touches (Capacitor makes each a
few lines): haptic feedback on the rest timer, local notifications for planned
sessions, or the native share sheet for finished workouts. Apps with real
functionality like TriTrack's usually pass, but this stacks the deck.

### Android / Google Play (bonus)

Much easier from Windows: Google Play costs a **one-time $25**, and
[PWABuilder](https://www.pwabuilder.com) can package this PWA into a signed
Android app in minutes — no Mac involved.

---

## Recommended path

1. **Now:** push to GitHub Pages, install on your own iPhone via *Add to Home
   Screen*, demo it, share the link.
2. **Next:** package for **Google Play** with PWABuilder ($25, doable today).
3. **When you get Mac access** (or set up Codemagic): Capacitor + App Store
   Connect using the steps above.
