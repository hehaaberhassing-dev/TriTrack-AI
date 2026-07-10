/* TriTrack — Strava sync + AI coach backend (Cloudflare Worker)
 *
 * Holds your secrets (browsers may never see them): the Strava client secret
 * for OAuth + activity fetching, and the Anthropic API key for AI-built
 * training plans.
 *
 * Required setup (see STRAVA-SETUP.md and AI-SETUP.md):
 *   - Secret env vars:  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
 *   - Secret env var:   ANTHROPIC_API_KEY  (only needed for the AI coach)
 *   - Optional env var: AI_MODEL           (defaults to claude-sonnet-4-6)
 *   - Plain env var:    ALLOWED_ORIGIN   (your app URL, e.g.
 *                       https://hehaaberhassing-dev.github.io  — origin only)
 *   - KV namespace binding named:  TOKENS
 *
 * Endpoints:
 *   GET  /auth?origin=<appUrl>  → sends the user to Strava to authorize
 *   GET  /callback?code=...     → Strava returns here; we store the refresh
 *                                 token and bounce back to the app with a session
 *   GET  /activities?session=..&after=<unix>  → returns new activities as JSON
 *   GET  /status?session=..     → { connected: bool }
 *   POST /ai-plan               → athlete profile JSON in, Claude-built plan out
 */

const STRAVA_AUTH = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function postToken(params) {
  return fetch(STRAVA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/* "Log in with Strava" sessions: connections are stored under the athlete's
   Strava ID, so logging in again on ANY device restores the same connection.
   The session token handed to the app is the athlete id + an HMAC signature
   (keyed with the client secret), so nobody can forge someone else's id. */
async function signId(idPart, env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.STRAVA_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("tritrack:" + idPart));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* Session token → KV key. Supports both the new athlete tokens ("a<id>.<sig>")
   and the old random-UUID sessions, so existing connections keep working. */
async function sessionToKey(session, env) {
  if (session && session.includes(".")) {
    const [idPart, sig] = session.split(".");
    if (/^a\d+$/.test(idPart) && sig === (await signId(idPart, env))) {
      return "athlete:" + idPart.slice(1);
    }
    return null; // tampered token
  }
  return session; // legacy session id (the KV key itself)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const allow = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(allow) });
    }

    // 1) Begin OAuth — redirect the user to Strava's permission screen.
    if (path.endsWith("/auth")) {
      const appOrigin = url.searchParams.get("origin") || allow;
      const redirectUri = url.origin + "/callback";
      const authUrl =
        `${STRAVA_AUTH}?client_id=${encodeURIComponent(env.STRAVA_CLIENT_ID)}` +
        `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&approval_prompt=auto&scope=activity:read_all` +
        `&state=${encodeURIComponent(appOrigin)}`;
      return Response.redirect(authUrl, 302);
    }

    // 2) OAuth callback — exchange the code, stash the refresh token, return to app.
    if (path.endsWith("/callback")) {
      const code = url.searchParams.get("code");
      const appOrigin = url.searchParams.get("state") || "/";
      if (!code) return new Response("Missing code", { status: 400 });

      const res = await postToken({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      });
      if (!res.ok) return new Response("Token exchange failed", { status: 502 });
      const tok = await res.json();

      // Prefer an athlete-identity session (same login on any device →
      // same connection); fall back to a random session if no athlete id.
      let session;
      const athleteId = tok.athlete && tok.athlete.id;
      if (athleteId) {
        const idPart = "a" + athleteId;
        session = idPart + "." + (await signId(idPart, env));
        await env.TOKENS.put("athlete:" + athleteId, JSON.stringify({ refresh_token: tok.refresh_token }));
      } else {
        session = crypto.randomUUID().replace(/-/g, "");
        await env.TOKENS.put(session, JSON.stringify({ refresh_token: tok.refresh_token }));
      }

      // Tell the app who connected, so it can show "Connected as <name>"
      // (catches wrong-account logins immediately).
      const athleteName = tok.athlete
        ? [tok.athlete.firstname, tok.athlete.lastname].filter(Boolean).join(" ")
        : "";
      const back = appOrigin + (appOrigin.includes("#") ? "&" : "#") + "strava_session=" + session +
        (athleteName ? "&strava_athlete=" + encodeURIComponent(athleteName) : "");
      return Response.redirect(back, 302);
    }

    // 3) Return activities newer than `after` (unix seconds).
    if (path.endsWith("/activities")) {
      const session = url.searchParams.get("session");
      const after = url.searchParams.get("after") || "0";
      if (!session) return json({ error: "no session" }, 400, allow);
      const kvKey = await sessionToKey(session, env);
      if (!kvKey) return json({ error: "bad session" }, 401, allow);

      const stored = await env.TOKENS.get(kvKey);
      if (!stored) return json({ error: "unknown session" }, 401, allow);
      const refresh_token = JSON.parse(stored).refresh_token;

      const rRes = await postToken({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token,
      });
      if (!rRes.ok) return json({ error: "refresh failed" }, 502, allow);
      const rtok = await rRes.json();

      // Strava rotates refresh tokens — persist the new one.
      if (rtok.refresh_token && rtok.refresh_token !== refresh_token) {
        await env.TOKENS.put(kvKey, JSON.stringify({ refresh_token: rtok.refresh_token }));
      }

      const out = [];
      for (let page = 1; page <= 12; page++) {
        const aRes = await fetch(
          `${STRAVA_API}/athlete/activities?after=${after}&per_page=200&page=${page}`,
          { headers: { Authorization: "Bearer " + rtok.access_token } }
        );
        if (!aRes.ok) break;
        const batch = await aRes.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const a of batch) {
          out.push({
            id: a.id,
            name: a.name,
            type: a.type,
            sport_type: a.sport_type,
            distance: a.distance,
            moving_time: a.moving_time,
            elapsed_time: a.elapsed_time,
            start_date: a.start_date,
          });
        }
        if (batch.length < 200) break;
      }
      return json(out, 200, allow);
    }

    // 4) AI coach — Claude builds a personalized training plan.
    if (path.endsWith("/ai-plan") && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: "AI not configured — add the ANTHROPIC_API_KEY secret (see AI-SETUP.md)" }, 501, allow);
      }
      const inp = await request.json().catch(() => null);
      if (!inp || typeof inp !== "object") return json({ error: "bad request" }, 400, allow);

      const weeks = Math.max(4, Math.min(40, parseInt(inp.weeks) || 16));
      const profile = {
        goal: String(inp.goal || "marathon").slice(0, 40),
        weeks,
        daysPerWeek: Math.max(3, Math.min(7, parseInt(inp.days) || 5)),
        level: String(inp.level || "intermediate").slice(0, 20),
        currentWeeklyRunKM: Number(inp.weeklyKM) || 0,
        longestRecentRunKM: Number(inp.longestRun) || 0,
        injuriesAndLimitations: String(inp.injuries || "").slice(0, 600),
        goalsAndNotes: String(inp.notes || "").slice(0, 600),
      };

      const system = [
        "You are an expert endurance running and triathlon coach. Build a complete week-by-week training plan from the athlete profile JSON in the user message.",
        "",
        "Coaching rules:",
        `- The plan is exactly ${weeks} weeks with exactly ${profile.daysPerWeek} training days per week; every remaining day is a "rest" session. Every week must cover all 7 days.`,
        "- Periodize: Base → Build → Peak → Taper. Deload every 4th week. Never grow weekly running volume more than ~10% per week. Long run on day 7, the main quality session on day 4.",
        `- Race day is week ${weeks}, day 7 — one session titled like "🏁 RACE DAY — <goal>".`,
        "- Take the athlete's injuries and limitations seriously: swap impact work for low-impact cross-training, cap volume, add cautionary cues. Safety beats ambition.",
        "- Triathlon goals (Ironman / 70.3) get swim and bike sessions alongside the running.",
        "- Honor the athlete's notes (target times, preferred session types, equipment limits).",
        "- Write titles and details in the language the athlete used in their notes/injuries; default to English. Keep each detail under 160 characters.",
        "",
        "Output ONLY one JSON object — no markdown fences, no commentary:",
        '{"goalLabel": string, "weeks": ' + weeks + ', "summary": string (2-3 sentences addressed to the athlete),',
        ' "phases": [{"name": string, "from": int, "to": int}],',
        ' "weekKM": [running km per week, ' + weeks + ' numbers],',
        ' "sessions": [{"week": 1..' + weeks + ', "day": 1..7, "sport": "run"|"bike"|"swim"|"strength"|"rest", "title": string, "detail": string}]}',
      ].join("\n");

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.AI_MODEL || "claude-sonnet-4-6",
          max_tokens: Math.min(32000, 3000 + weeks * 600),
          system,
          messages: [{ role: "user", content: JSON.stringify(profile) }],
        }),
      });
      if (!aiRes.ok) {
        const detail = await aiRes.text().catch(() => "");
        return json({ error: "AI request failed (HTTP " + aiRes.status + ") " + detail.slice(0, 200) }, 502, allow);
      }
      const msg = await aiRes.json();
      const text = (msg.content || []).map((b) => b.text || "").join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return json({ error: "AI returned no plan" }, 502, allow);
      try {
        return json({ plan: JSON.parse(match[0]) }, 200, allow);
      } catch {
        return json({ error: "AI returned invalid JSON — try again" }, 502, allow);
      }
    }

    if (path.endsWith("/status")) {
      const session = url.searchParams.get("session");
      const kvKey = session ? await sessionToKey(session, env) : null;
      const connected = !!(kvKey && (await env.TOKENS.get(kvKey)));
      return json({ connected }, 200, allow);
    }

    return new Response("TriTrack Strava sync worker is running.", {
      headers: corsHeaders(allow),
    });
  },
};
