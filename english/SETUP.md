# Mr. D · English Class — Setup Guide

Follow these steps **before deploying**. Do them in order.

---

## Step 1: Supabase Tables

Open your Supabase dashboard → SQL Editor → paste and run this entire block:

```sql
-- ════════════════════════════════════════════════
-- Mr. D English Class — Database Schema
-- Run this in Supabase SQL Editor (project: fvrwxuwkwwrajuausuaj)
-- ════════════════════════════════════════════════

-- Learners (one row per person)
CREATE TABLE IF NOT EXISTS eng_learners (
  handle           TEXT PRIMARY KEY,
  path             TEXT,                    -- 'grammar' | 'speech' | 'both' | null
  level            INT DEFAULT 1,           -- grammar starting level (1-3)
  streak_count     INT DEFAULT 0,
  streak_last_day  DATE,
  display_name     TEXT,
  email            TEXT,                    -- optional, v1
  paid_until       TIMESTAMPTZ,             -- v1 Stripe
  trial_drill_used BOOLEAN DEFAULT FALSE,
  notes            TEXT,                    -- Mr. D's private notes (not exposed to anon)
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Diagnostic attempts
CREATE TABLE IF NOT EXISTS eng_diagnostics (
  id               BIGSERIAL PRIMARY KEY,
  handle           TEXT REFERENCES eng_learners(handle) ON DELETE CASCADE,
  answers          JSONB,                   -- array of 12 selected option indices
  score_grammar    INT,                     -- 0-5 ability score
  recommended_path TEXT,
  chosen_path      TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Lesson completion tracking
CREATE TABLE IF NOT EXISTS eng_progress (
  handle       TEXT REFERENCES eng_learners(handle) ON DELETE CASCADE,
  lesson_id    INT,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (handle, lesson_id)
);

-- Written submissions (lesson writebacks)
CREATE TABLE IF NOT EXISTS eng_submissions (
  id               BIGSERIAL PRIMARY KEY,
  handle           TEXT REFERENCES eng_learners(handle) ON DELETE CASCADE,
  lesson_id        INT,
  body             TEXT,
  auto_feedback    TEXT,                    -- v1: Claude auto-grading
  instructor_note  TEXT,                   -- v1: Mr. D's note
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Speech drill sessions
CREATE TABLE IF NOT EXISTS eng_drills (
  id                  BIGSERIAL PRIMARY KEY,
  handle              TEXT REFERENCES eng_learners(handle) ON DELETE CASCADE,
  started_at          TIMESTAMPTZ,
  duration_s          INT,
  topic               TEXT,
  transcript          JSONB,               -- [{role, content}]
  summary             TEXT,
  counted_for_streak  BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- In-app messages (learner ↔ Mr. D)
CREATE TABLE IF NOT EXISTS eng_contact_pings (
  id               BIGSERIAL PRIMARY KEY,
  handle           TEXT REFERENCES eng_learners(handle) ON DELETE CASCADE,
  body             TEXT,
  direction        TEXT,                   -- 'learner→teacher' | 'teacher→learner'
  seen_by_teacher  BOOLEAN DEFAULT FALSE,
  seen_by_learner  BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Speech path waitlist
CREATE TABLE IF NOT EXISTS eng_waitlist (
  handle      TEXT PRIMARY KEY REFERENCES eng_learners(handle) ON DELETE CASCADE,
  email       TEXT,
  signed_up_at TIMESTAMPTZ DEFAULT NOW()
);


-- ════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Enable RLS on all tables, then define policies
-- ════════════════════════════════════════════════

ALTER TABLE eng_learners      ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_diagnostics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_progress      ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_drills        ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_contact_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE eng_waitlist      ENABLE ROW LEVEL SECURITY;

-- eng_learners: anon can insert (claim a handle) and read/update their own row
-- The 'notes' column is NOT included in anon grants (see below)
CREATE POLICY "learner_insert" ON eng_learners FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "learner_select" ON eng_learners FOR SELECT TO anon USING (true);
CREATE POLICY "learner_update" ON eng_learners FOR UPDATE TO anon USING (true);

-- All other tables: anon can do everything filtered by handle equality client-side
-- (Security = obscurity of 6-char handle, same model as sbg room codes)
CREATE POLICY "diag_all"    ON eng_diagnostics   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "prog_all"    ON eng_progress       FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "subs_all"    ON eng_submissions    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "drills_all"  ON eng_drills         FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "pings_all"   ON eng_contact_pings  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "wait_all"    ON eng_waitlist       FOR ALL TO anon USING (true) WITH CHECK (true);


-- ════════════════════════════════════════════════
-- COLUMN GRANTS (both layers — missing either is a vuln)
-- Grant anon access to specific columns only
-- ════════════════════════════════════════════════

-- eng_learners: exclude 'notes' from anon access
GRANT SELECT (handle, path, level, streak_count, streak_last_day, display_name,
              email, paid_until, trial_drill_used, created_at)
  ON eng_learners TO anon;
GRANT INSERT (handle, path, level, streak_count, streak_last_day, display_name,
              email, paid_until, trial_drill_used)
  ON eng_learners TO anon;
GRANT UPDATE (path, level, streak_count, streak_last_day, display_name,
              email, paid_until, trial_drill_used)
  ON eng_learners TO anon;

GRANT SELECT, INSERT, UPDATE ON eng_diagnostics   TO anon;
GRANT SELECT, INSERT, UPDATE ON eng_progress       TO anon;
GRANT SELECT, INSERT, UPDATE ON eng_submissions    TO anon;
GRANT SELECT, INSERT, UPDATE ON eng_drills         TO anon;
GRANT SELECT, INSERT, UPDATE ON eng_contact_pings  TO anon;
GRANT SELECT, INSERT, UPDATE ON eng_waitlist       TO anon;

GRANT USAGE ON SEQUENCE eng_diagnostics_id_seq   TO anon;
GRANT USAGE ON SEQUENCE eng_submissions_id_seq   TO anon;
GRANT USAGE ON SEQUENCE eng_drills_id_seq        TO anon;
GRANT USAGE ON SEQUENCE eng_contact_pings_id_seq TO anon;
```

Run it. Check for errors. If any table already exists, you can drop and recreate — there's no existing data yet.

---

## Step 2: Admin Key (for teacher dashboard)

1. Open your browser console (F12 → Console tab)
2. Run this code:
```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('your-secret-key-here'))
  .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
```
3. Replace `your-secret-key-here` with whatever you want your key to be (make it long and random)
4. Copy the 64-character hex output
5. Open `english/teacher/index.html` and replace `FILL_IN_SHA256_OF_YOUR_KEY_HERE` with that hex string
6. Bookmark: `oprek.net/english/teacher?key=your-secret-key-here`

That bookmark IS your login. Keep it private.

---

## Step 3: Anthropic API Key

For the Speech drill's AI brain (Claude Haiku 4.5), you need to set up a Supabase Edge Function. This protects your API key from being exposed in the frontend HTML.

### Create the Edge Function

In your Supabase project → Edge Functions → Create new function → Name it `eng-drill-chat`.

Paste this code:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  const { topic, history, mode } = await req.json();

  const systemPrompt = mode === "cooldown"
    ? `You are Mr. D's AI assistant giving brief, encouraging feedback on an English speaking practice session.
       The topic was: ${topic}.
       Review the conversation history and return JSON:
       {"good": ["thing 1", "thing 2", "thing 3"], "improve": "one specific, kind suggestion"}
       Keep each "good" point to one sentence. Keep "improve" to one sentence. Be honest but kind.`
    : `You are Mr. D's AI English conversation partner. Topic: "${topic}".
       Keep responses SHORT — 1-2 sentences max. Ask one follow-up question at the end.
       Gently correct grammar only if it's a clear mistake — weave the correction naturally into your response.
       Be warm, encouraging, and conversational. Do NOT lecture. Do NOT use bullet points.
       Respond in plain text only. Return JSON: {"reply": "your response here"}`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: mode === "cooldown" ? 400 : 150,
    system: systemPrompt,
    messages: mode === "cooldown"
      ? [{ role: "user", content: "Please give feedback on this conversation." }]
      : history.map((m) => ({ role: m.role, content: m.content }))
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { reply: text, feedback: text }; }

  return new Response(JSON.stringify(parsed), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
});
```

Then in Supabase → Edge Functions → `eng-drill-chat` → Secrets:
- Add secret: `ANTHROPIC_API_KEY` = your Anthropic API key

---

## Step 4: ElevenLabs API Key (for voice TTS)

Create a second Edge Function named `eng-drill-tts`:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ELEVENLABS_KEY = Deno.env.get("ELEVENLABS_API_KEY") || "";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  const { text, voice_id } = await req.json();
  const vid = voice_id || "pNInz6obpgDQGcFmaJgB"; // Default: Adam voice

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2",        // Flash/Turbo — cheapest at ~$0.05/1k chars
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });

  if (!res.ok) {
    // Fallback: return empty audio, frontend will use browser TTS
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const audio = await res.arrayBuffer();
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Access-Control-Allow-Origin": "*"
    }
  });
});
```

Then add secret: `ELEVENLABS_API_KEY` = your ElevenLabs API key

**To get a voice ID:** Go to ElevenLabs → Voices → copy the ID of the voice you want.
The default in the function (`pNInz6obpgDQGcFmaJgB`) is "Adam" — a clear male voice.

Also update this line in `english/index.html`:
```js
const ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // replace with your chosen voice ID
```

---

## Step 5: Twilio Notifications (optional but recommended)

When a learner sends you a message, this notifies you via WhatsApp or SMS.

**If you want to skip this for now:** No action needed. You'll just have to check the admin dashboard manually to see new messages. The contact system still works — learners can still message you.

**To set it up:**

1. Create a Twilio account at twilio.com (free trial credit included)
2. Get a Twilio phone number with WhatsApp capability (or just SMS)
3. Create a Supabase Edge Function named `eng-notify-teacher`:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TWILIO_SID    = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN  = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_FROM   = Deno.env.get("TWILIO_PHONE_FROM") || "";  // your Twilio number, e.g. +14155238886
const TEACHER_PHONE = Deno.env.get("TEACHER_PHONE") || "";      // your personal number, e.g. +6281234567890

serve(async (req) => {
  const payload = await req.json();
  // Trigger on eng_contact_pings INSERT where direction = 'learner→teacher'
  const record = payload.record;
  if (!record || record.direction !== "learner→teacher") {
    return new Response("ok");
  }

  const excerpt = record.body.slice(0, 100);
  const msg = `[Mr.D English] ${record.handle}: "${excerpt}"`;

  const params = new URLSearchParams({
    To: TEACHER_PHONE,
    From: TWILIO_FROM,
    Body: msg
  });

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  return new Response("ok");
});
```

4. Add secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_FROM`, `TEACHER_PHONE`
5. In Supabase → Database → Webhooks → Create webhook:
   - Table: `eng_contact_pings`
   - Event: INSERT
   - URL: `https://fvrwxuwkwwrajuausuaj.supabase.co/functions/v1/eng-notify-teacher`
   - Add header: `Authorization: Bearer <your-service-role-key>`

**Cost:** Indonesia SMS ≈ $0.04/message. WhatsApp via Twilio ≈ $0.005/message. Easily under $1/month for early usage.

---

## Step 6: Write Your 6 Grammar Lessons

Open `english/index.html` and find the `LESSONS` constant near the top of the `<script>` section.

The 6 lessons are already written with basic content. Before you launch, read through each one and:
- Edit the explanations to match your teaching style
- Add your own examples, especially Indonesian-relevant ones
- Adjust or replace the MCQ exercises if needed
- Rewrite the writeback prompts if you want different tasks

Each lesson uses Markdown formatting. The app renders it automatically.

---

## Step 7: Final Configuration Checklist

Open `english/index.html` and confirm:
- [ ] `SUPABASE_URL` — already set (your existing project)
- [ ] `SUPABASE_ANON` — already set (your existing anon key)
- [ ] `ELEVENLABS_VOICE_ID` — set to your chosen voice ID
- [ ] `EDGE_BASE` — already set (auto-uses your Supabase URL)

Open `english/teacher/index.html` and confirm:
- [ ] `ADMIN_KEY_HASH` — set to your SHA-256 hash from Step 2

---

## Step 8: Deploy

Run `deploy.bat` from the project root. That's it.

Your URLs after deploy:
- **Learner app:** `oprek.net/english`
- **Teacher admin:** `oprek.net/english/teacher?key=YOUR_KEY` (bookmark this)

---

## Step 9: Verification Checklist

Work through these after deploying:

1. **Cold landing:** Open `oprek.net/english` in incognito. Starfield shows. Two-path cards visible.
2. **Diagnostic:** Click "Begin". Complete all 12 questions. Result screen shows recommended path.
3. **Handle persistence:** Note your handle. Close tab. Reopen — goes straight to dashboard.
4. **Cross-device recovery:** New browser → "I have a handle" → type code → dashboard loads.
5. **Grammar lesson:** Open a lesson. Complete MCQs. Submit writeback. Dashboard shows lesson complete + streak incremented.
6. **Speech trial:** Open Speech path. Run drill. Verify ElevenLabs voice plays (or browser TTS fallback works). After drill: `trial_drill_used = true` in Supabase.
7. **Contact:** Send a message. Check Supabase `eng_contact_pings`. If Twilio configured: your phone receives WA/SMS notification.
8. **Admin inbox:** Open admin URL. See the ping. Type a reply. Send. Back in learner app → messages tab shows reply.
9. **Admin gate:** Open `oprek.net/english/teacher` WITHOUT the key. Should not load (redirect or blank). WITH key: loads fine.
10. **RLS check:** In Supabase SQL Editor: `SELECT * FROM eng_learners` — should show all rows (service role reads everything). Confirm `notes` column is not accessible via the anon key (test with an HTTP request using the anon key).

---

## Costs to Track

| Service | Free tier | Cost after |
|---|---|---|
| Supabase | 500MB DB, 2 Edge Functions | Free for this scale |
| ElevenLabs | 10,000 chars/month | $0.05/1k chars (Flash) |
| Claude Haiku 4.5 | Pay-as-you-go | ~$0.04/drill |
| Twilio | Free trial credit | ~$0.005-$0.04/message |
| Vercel | Unlimited for static | Free |

**At 10 active learners in v0:** Estimated ~$1-3/month total. Manageable.

---

## Upgrading to v1

When you're ready to open Speech fully and add payment:

1. Add Stripe — create a payment link for "Speech Monthly"
2. Add a Supabase webhook on Stripe `checkout.session.completed` → update `eng_learners.paid_until`
3. In `english/index.html`: change the 1-drill cap to check `paid_until > now()` instead of `trial_drill_used`
4. Add lesson authoring UI in teacher admin
5. Optional: add email field and Resend.com for recovery emails
