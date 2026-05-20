# Sound BINGO

> Real-time English phonology bingo for the UNINDRA English Education Department. Single-file vanilla SPA, Supabase multiplayer, intentionally no build step.

**Live**: https://dhiya.id/unindra/sbg/
**Source**: `unindra/sbg/index.html` (~2900 lines, the entire app)

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [Data Model](#data-model)
5. [Module Reference](#module-reference)
6. [Game Modes](#game-modes)
7. [Features Deep-Dive](#features-deep-dive)
8. [Gotchas & Lessons Learned](#gotchas--lessons-learned)
9. [How to Extend](#how-to-extend)
10. [Deployment](#deployment)
11. [Deferred Work / Known Limitations](#deferred-work--known-limitations)
12. [File Map](#file-map)
13. [Changelog Highlights](#changelog-highlights)

---

## Overview

Sound BINGO is a classroom phonology game. The teacher speaks an English word, students identify the target sound (in IPA notation) on their bingo card, and mark it. First to complete the win pattern shouts BINGO. Built specifically for ESP (English for Specific Purposes) phonology teaching at UNINDRA.

**Three game modes**:
- **Digital classroom** — students join with their phones via a 4-digit code, real-time multiplayer
- **Print** — paper bingo cards generated in-browser, then a digital caller drives the round
- **Solo** — single-player practice with time pressure, fully offline

**Audience this README serves**:
- Future AI agents picking up the project mid-iteration
- Human contributors who need to extend, debug, or understand decisions
- The original user (non-technical owner) reviewing what's there

If you're an AI agent: start with [Architecture](#architecture) and [Gotchas](#gotchas--lessons-learned). Those two sections compress the institutional knowledge that's most expensive to rediscover.

---

## Quick Start

### Running locally

It's one HTML file. Open `unindra/sbg/index.html` in any modern browser. That's it.

(Supabase calls won't work over `file://` due to mixed-content rules — host via `python -m http.server` or any local server if you need the multiplayer features.)

### Deploying

From the **repo root** (`E:\Claude Code Projects\Mr.D\`): `deploy.bat`.

Note: `deploy.bat` only touches the landing page artifact and the assets folder. **It does NOT touch `unindra/sbg/index.html`** — edits there are picked up by Vercel directly via the project's folder structure. See [Deployment](#deployment) for the full breakdown.

### Playing as a teacher

1. Home → "I'm the Teacher"
2. Pick **mode** (Digital cards / Print cards) — Digital is the multiplayer flow, Print outputs paper cards
3. Pick **difficulty** — Easy 3×3 (9 sounds), Normal 4×4 (16), Hard 5×5 (24, center is FREE)
4. (Optional but powerful) **Guaranteed Sounds** → tap "Pick guaranteed sounds" to force specific sounds onto every student's card AND into the caller queue. More guarantees → less luck-of-the-draw → more wins per round.
5. (Optional) **⚙️ Options** → enabled categories, caller speed, win condition (Line / Two Lines / Full House), auto-reveal IPA + delay, strict marking, highlight tappable cells
6. **▶ Start Game** → lobby screen with the 4-digit code → wait for students to join → **▶ Start Calling**
7. Caller screen with the **📊 LIVE** sidebar on the right edge for real-time student progress. Tap the tab to expand.

### Playing as a student

1. Home → "I'm a Student"
2. Type your **name** (or 🎲 for a random pseudonym — "Cosmic Otter", "Sleepy Comet", etc.)
3. Enter the **4-digit code** the teacher shows
4. Your bingo card appears with a "waiting for teacher" panel until the game starts
5. When the teacher calls a word, the matching cell on your card glows gold (if Highlight Tappable is on). **Tap it** to mark.
6. Wrong tap → cell shakes, no mark. Right tap → gold + glow.
7. Complete the win pattern → tap **🎰 BINGO!** → show the win modal to your teacher

---

## Architecture

### The single-file constraint

The entire app — HTML, CSS, JS, sound data, multiplayer logic — lives in **one file**: `unindra/sbg/index.html`.

**Why**:
- **Offline-friendly** — schools with poor connectivity can mirror the file to a USB drive
- **Print mode** — paper bingo cards render via the same HTML, no separate template
- **Zero build** — edit, refresh, done. No npm, no webpack, no toolchain rot.
- **Easy distribution** — one file, anywhere
- **AI-friendly** — the entire project fits in one Read/Grep pass

**When you're tempted to extract modules**: don't. The constraint is intentional. Use clear comment blocks (`/* ════════════ MODULE NAME ════════════ */`) and large object literals instead.

### Backend: Supabase

**Project**: `Sandbox` (org: DevAmuh's org)
**URL**: `https://fvrwxuwkwwrajuausuaj.supabase.co`
**Anon key**: committed in the HTML (`SUPABASE_ANON` constant). Public-safe because RLS + GRANTs protect data.

Four tables: `rooms`, `cards`, `calls`, `claims`. See [Data Model](#data-model).

### Event model — the room channel

All multiplayer events flow through **a single Supabase Broadcast channel** per session: `room:XXXX` where `XXXX` is the 4-digit room code.

Three event types travel on this channel:

| Event | Direction | Payload | Throttled? |
|-------|-----------|---------|------------|
| `call` | Teacher → Students | `{word, soundId, soundLabel}` | No (teacher pace) |
| `start` | Teacher → All | `{}` | No (once per round) |
| `progress` | Student → Teacher dashboard | `{cardId, name, layout, markedIds}` | 300ms per student |

Both teacher and students hold **two channel objects** on `room:XXXX`:
- One via `Net._ensureBC(roomId)` — lazy singleton, used for **sending** broadcasts
- One via `Net.subscribeRoomEvents(roomId, handlers)` — used for **receiving** events

Supabase deduplicates at the Phoenix channel level on the server, so two client-side channel objects on the same channel name work fine. Don't try to consolidate them — it complicates handler registration and tear-down.

### Why Broadcast and not Postgres Changes?

| Aspect | Broadcast | Postgres Changes |
|--------|-----------|------------------|
| Latency | <100ms | 200–500ms+ |
| Setup | Just send/receive | Requires `alter publication supabase_realtime add table ...` |
| DB pressure | Zero | One write per event |
| Use for | Live, transient state | Durable game-state changes |

We use **Broadcast** for calls, starts, and progress (live, transient).
We use **Postgres Changes** for claims (the teacher needs to review BINGO claims as durable game-events).

DB tables are still the **source of truth** for:
- Room metadata (`rooms`)
- Call history (`calls` — for late-joiner replay)
- Card layouts + names + current marked state (`cards`)
- Pending BINGO claims (`claims`)

Broadcast is the **live wire**; the DB is the **history book**.

### Lobby + start synchronization

Earlier versions had a "first-call race" — teacher calls before student finishes subscribing → call lost. Solution: explicit lobby phase.

```
Teacher                                  Students
-------                                  --------
createRoom(status='lobby')
                                         joinRoom (sees status='lobby')
                                         subscribe to room:XXXX
                                         show waiting panel
Start Calling button
  → update status='playing'
  → broadcast 'start'                    receive 'start'
                                         hide waiting panel
broadcast 'call' #1                      receive 'call' #1 ✓
broadcast 'call' #2                      receive 'call' #2 ✓
...                                      ...
```

Late joiners (joining after `status='playing'`) get historical calls via `Net.joinRoom`'s `recentCalls` field, replayed through `Player._autoMark`.

---

## Data Model

### `rooms`

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | 4-digit code. First digit encodes difficulty: 1=easy, 2=normal, 3=hard. |
| `difficulty` | text | 'easy' / 'normal' / 'hard' |
| `win_condition` | text | 'line' / 'twolines' / 'fullhouse' |
| `enabled_cats` | text[] | Categories included (consonant, short_vowel, long_vowel, diphthong) |
| `strict_marking` | bool | On = only the latest call is tappable; off = all called-but-untapped stay armed |
| `highlight_tappable` | bool | On = armed cell glows + others dim; off = uniform appearance |
| `guaranteed_sounds` | text[] | Sound IDs forced onto every card and into caller queue |
| `status` | text | 'lobby' (pre-start) or 'playing' (after teacher hits Start Calling) |
| `started_at` | timestamptz | Timestamp of Start Calling |
| `created_at` | timestamptz | Auto-populated on insert; used by `purge_room_if_stale` / `purge_stale_rooms` to detect never-started rooms older than the staleness threshold |

### `cards`

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | 5-digit card ID |
| `room_id` | text FK | → `rooms.id` |
| `layout` | text[] | Sound IDs in grid order, `null` for FREE square (hard mode center) |
| `display_name` | text | Student's name or pseudonym |
| `marked` | text[] | Sound IDs the student has marked (live state, updated on every mark) |

### `calls`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint PK | Auto-incrementing |
| `room_id` | text FK | → `rooms.id` |
| `word` | text | The spoken word, e.g., "ship" |
| `sound_id` | text | Phoneme ID, e.g., "sh" |
| `sound_label` | text | IPA label, e.g., "/ʃ/" |
| `created_at` | timestamptz | For ordering in late-joiner replay |

### `claims`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint PK | Auto-incrementing |
| `room_id` | text FK | → `rooms.id` |
| `card_id` | text FK | → `cards.id` |
| `layout` | text[] | Snapshot at claim time (for teacher verification) |
| `marked` | bool[] | Marked state at claim time |
| `created_at` | timestamptz | For ordering teacher review |

### RLS + GRANTs (read this twice)

**Both layers must be configured for the `anon` role.** This burned hours during initial setup.

```sql
-- GRANTs (table-level privileges for the anon role)
grant select, insert on rooms to anon;
grant update on rooms to anon;
grant select, insert on calls to anon;
grant select, insert, update on cards to anon;
grant select, insert, update on claims to anon;
grant usage on sequence calls_id_seq to anon;
grant usage on sequence claims_id_seq to anon;

-- RLS policies (per-row access — should allow read/write for anon on all 4 tables)
-- (See Supabase dashboard for current policy definitions.)

-- Realtime publication (so postgres_changes subscriptions fire on claims)
alter publication supabase_realtime add table claims;
-- (calls and progress use Broadcast, not postgres_changes — no publication needed)
```

**Two distinct error messages indicate two distinct layers**:
- `"permission denied for table X"` → **GRANT** is missing
- `"violates row-level security policy"` → **RLS** policy is rejecting

Supabase auto-creates RLS policies for some tables but does **not** auto-grant table privileges to anon. Check both layers when something writes successfully (`200 OK`) but no rows appear in the table — that means RLS passed but a different write got blocked, or a column-level grant is missing.

---

## Module Reference

The whole app lives in `index.html`, but each major chunk has a clear comment-block divider. Here's the conceptual map:

### `St` — Application state
Global state object. Holds the teacher's local preferences (`enabledCats`, `callSpeed`, `winCondition`, `autoReveal`, `autoRevealDelay`, `strictMarking`, `highlightTappable`, `guaranteedSounds`) and the current session (`sessionCode`, `difficulty`, `calledHistory`).

### `UI` — Screen + overlay navigation
`UI.go(id)` switches screens. `UI.showOv(id)` / `UI.closeOv(id)` opens/closes modals. `UI.goCard()` is the student entry path (resets card UI then navigates).

### `Teacher` — Setup screen controller
`Teacher.launch()` — creates room, navigates to lobby (digital) or print-screen (print mode).
`Teacher.openGuaranteed()`, `Teacher.toggleGuar()`, `Teacher.clearGuar()` — the guaranteed sounds picker.
`Teacher.setDiff(d)` — also clears guarantees if they exceed the new difficulty's grid count.

### `LobbyT` — Teacher lobby
Polls `cards` table every 2.5s to show live joined-student count. `LobbyT.start()` calls `Net.startGame` (which updates status + broadcasts the `start` event), then transitions to caller-screen and opens the Dashboard sidebar.

### `Caller` — Teacher caller screen
Builds the word queue from `callerSoundsFor(diff)` (guarantee-aware), manages auto/manual call progression, fires `Net.pushCall` on each call. Has the IPA reveal mechanism (auto or manual, with configurable delay).

### `Player` — Student card controller
- `Player.applyCode()` — validates name + code, joins room, builds card, subscribes to broadcasts
- `Player.mark(i)` — handles cell tap. Wrong → shake. Right → gold mark.
- `Player.onCallReceived(ev)` — incoming broadcast → updates Now Calling panel + arms the matching cell
- `Player._autoMark(soundId)` — used ONLY for late-joiner replay (no armed-gate check)
- `Player._emitProgress()` — throttled (300ms) broadcast + persist to `cards.marked`
- `Player.callBingo()` — checks win, submits claim, shows win modal
- `Player._refreshArmedState()` — recomputes which cells get `.armed` / `.dimmed` classes
- `Player._renderHistory()` — the student-side called-sounds chip strip

### `Net` — Supabase networking layer
All multiplayer DB + broadcast calls live here. Key methods:

| Method | Purpose |
|--------|---------|
| `createRoom(...)` | Insert into `rooms` with all settings |
| `joinRoom(code)` | Fetch room state + historical calls; returns `{found, ...room, recentCalls}` |
| `startGame(roomId)` | Update `rooms.status='playing'` + broadcast `'start'` |
| `pushCall(roomId, word, sound)` | Broadcast `'call'` + insert into `calls` |
| `subscribeRoomEvents(roomId, {onCall, onStart, onProgress})` | Returns an unsub fn |
| `registerCard(roomId, cardId, layout, displayName, marked)` | Queued upsert into `cards` (initial register) |
| `upsertCardProgress(roomId, cardId, displayName, layout, markedIds)` | Queued upsert with full state (used on every mark — replaces old `updateMarked`) |
| `broadcastProgress(roomId, payload)` | Broadcast `'progress'` event (now awaits send + logs failures) |
| `listCards(roomId)` | Fetch all cards for dashboard initial load |
| `submitClaim(...)` / `subscribeClaims(...)` | BINGO claim flow (postgres_changes) |

Internal: `_ensureBC(roomId)` — lazy singleton broadcast channel for **sending**. Created once on first `pushCall`, reused thereafter. Different channel from `subscribeRoomEvents`.

Internal: `_cardWriteQ` + `_queuedCardUpsert(payload)` — serializes all `cards` table writes per client. See Gotcha #11.

### `Dashboard` — Live student progress board
- `Dashboard.open(roomId)` — opens sidebar, queries `cards` for initial state, subscribes to `'progress'`, sets up 8s catch-up poll
- `Dashboard.close()` — tear-down
- `Dashboard.render()` — sorted leaderboard with mini-grids (dots-style)
- `Dashboard.toggle()` — collapse/expand the sidebar
- `Dashboard.popout()` — opens `index.html?dashboard=ROOMID` in a new window
- `Dashboard.bootStandalone(roomId)` — fired on page load if URL has `?dashboard=` param. Switches to full-page dashboard mode.

### `Solo` — Single-player mode
Independent of multiplayer. Its own queue (`Solo._buildQueue`), time-pressure mechanic (auto-advance after countdown), separate `_checkWin`. **Does not touch Supabase.** Useful for offline practice.

### `Print` — Print card generator
- `Print.gen()` — renders N bingo cards with guaranteed sounds baked into every card + random fillers
- `Print._renderBanner()` — transparency banner above the preview ("Locked-in sounds on every card: ...")
- `Caller.launchAfterPrint()` — transitions to caller-screen after teacher prints, also using `callerSoundsFor(diff)`

### `FX` — Visual effects
- `FX.celebrate(win, gridId)` — dispatcher for the three win-type animations
- `FX.bingoLine(indices, gridId)` — single SVG line through winning cells
- `FX.bingoFullHouse(gridId)` — gold rectangle around grid + 24 sparkles + word pop
- `FX.pop(el)` — cell-pop ring effect on mark
- `FX.bigBingo()` — confetti burst
- `FX.cleanup()` — tear down all tracked elements + timers

### `WinDemo` — Animated win-pattern explainer
Shown before each game start. Visually demonstrates what counts as a win for the active win condition. Tightly coupled to the `ov-winpatterns` modal.

### `Glossary` — Sound reference modal
Tab-based viewer of all 24 sounds with tips, example words, and IPA. Built once per `showOv('ov-glossary')` call.

### `Home` — Home-screen toggle
`Home.toggleClassroom()` — expand/collapse the "In a Classroom" path's sub-options.

### Helpers (top-level functions)

| Function | Purpose |
|----------|---------|
| `soundsForDiff(diff)` | Enabled sounds for a difficulty (sliced to grid_count) |
| `callerSoundsFor(diff)` | Guarantee-aware version (forces guarantees + random fillers) |
| `pseudonym()` | "Cosmic Otter"-style random pseudonym |
| `throttle(fn, ms)` | Throttle utility used for progress emissions |
| `escapeHtml(s)` | XSS-safe text rendering |
| `speak(w)` | Web Speech API wrapper (English voice, slightly slower rate) |
| `shuffle(arr)` | Fisher-Yates shuffle (immutable; returns new array) |
| `cardId()` | Random 5-digit card ID |
| `genCode(diff)` | 4-digit room code with first digit encoding difficulty |
| `highlightCallerWord(w, s)` | Visual highlight of the target sound's letters within the word |
| `checkWarning()` | Renders "not enough sounds enabled" warning in Options |
| `showVignette(btnId, msg, storeKey)` | One-time spotlight tooltip with permanent dismiss |

---

## Game Modes

### Digital classroom (the main path)
```
Teacher: Home → "I'm the Teacher" → Setup → Start Game → Lobby → ▶ Start Calling → Caller
Student: Home → "I'm a Student" → enter name + code → waiting panel → playing
```
Real-time multiplayer via Supabase Broadcast. Late joiners replay history from the DB. Dashboard sidebar on the caller-screen.

### Solo
```
Home → "On My Own" → solo setup overlay → solo screen with caller bar + card
```
Auto-advance with time pressure (configurable). No Supabase, no broadcast. Fully offline. Good for individual practice between classes.

### Print
```
Teacher: Setup → Print mode → Start Game → print-screen → 🖨️ Print Now → ▶ Start Caller
```
N bingo cards rendered with guarantees baked in. Transparency banner shows exactly what's locked in. After printing, the same caller-screen handles digital students if there are any.

---

## Features Deep-Dive

### Guaranteed sounds (the RNG lever)

Teacher picks N sounds from the 24-sound pool. Those sounds:
1. Appear on **every** student card (forced)
2. Appear in the **caller queue** (forced — `callerSoundsFor(diff)` biases toward them)
3. Remaining slots filled with random sounds from enabled categories

| Guarantees | Effect |
|------------|--------|
| 0 picked | Fully random (legacy behavior) |
| N < grid_count picked | N forced on every card + (grid_count - N) random fillers per card; same N + random fillers in caller queue |
| N = grid_count picked | **Every card has the exact same sounds** + every call is on every card → everyone wins together when the win condition is met |

Difficulty downgrade clears guarantees that no longer fit (with an alert).

### Strict marking

| Mode | Behavior |
|------|----------|
| **Strict** (default) | Only the most recently called sound is "armed" (tappable). Miss it before the next call → opportunity lost. |
| **Forgiving** | All called-but-untapped sounds remain armed. Students catch up at their own pace. |

Stored per-room (`rooms.strict_marking`). The teacher's local toggle becomes the room setting at `Net.createRoom` time.

### Highlight tappable

| Mode | Behavior |
|------|----------|
| **On** (default) | Armed cells pulse gold; non-armed cells dim. Students see exactly where to tap. |
| **Off** | All cells look identical. Students must identify the sound on their own. Harder, better phonology practice. |

Stored per-room. Wrong taps still shake either way.

### Win conditions

| Condition | Trigger | Animation |
|-----------|---------|-----------|
| **Line** | Any complete row, column, or diagonal | Single SVG line through winning cells |
| **Two lines** | Any two complete lines | Two staggered SVG lines (220ms apart) |
| **Full house** | All cells marked | Gold rectangle around grid + 24 sparkles + "🎰 FULL HOUSE!" word pop |

`Player._checkWin(gs)` returns `{type, lines, cells}` or `null`. `FX.celebrate(win, gridId)` dispatches.

`Solo._checkWin` mirrors the same shape (kept in sync — when extending one, extend the other).

### Live dashboard

Right-side collapsible sidebar on caller-screen. Defaults to **collapsed** (just a "📊 LIVE" tab on the right edge) so the projector stays clean unless the teacher decides to show it.

Each student row:
- Rank (1, 2, 3…)
- Display name (pseudonym or real)
- Mini-grid (dots: gold = marked, teal = FREE, grey = unmarked)
- Count (e.g., "5/9")

Leader (#1, count > 0) gets a gold tint + glow.

**State sources**:
1. **Broadcast events** (`progress`) — live updates, throttled at 300ms per student
2. **Polling** `cards` table every 8s — catches dropped broadcasts
3. **Initial load** queries `cards` on `Dashboard.open(roomId)`

**Conflict resolution**: recent broadcasts (<2.5s old) win over stale DB reads.

### Pop-out dashboard

`Dashboard.popout()` opens `index.html?dashboard=ROOMID` in a new window (560×920).

Standalone boot:
- Adds `body.dashboard-only` CSS class (hides all other screens via `display:none !important`)
- Sidebar becomes full-page (cells scale larger: 60/80/100px grids vs sidebar's 42/54/66px)
- Subscribes to broadcasts + queries `cards`
- Sets document title to `📊 Dashboard · Room XXXX · Sound BINGO`

**Use case**: teacher projects the caller view to the class, keeps the dashboard private on their laptop. Or projects the dashboard so students can self-monitor on a shared screen.

### Pseudonym randomizer

Privacy-friendly default. The 🎲 button picks from `PSEUDO_ADJ × PSEUDO_NOUN` (≈480 combos). Students who leave the name field blank get a pseudonym auto-generated on submit. Saved name persists in `localStorage` under `sbg.playerName`.

---

## Gotchas & Lessons Learned

These are the institutional memories — the things that take hours to discover and seconds to apply once you know them.

### 1. RLS policies ≠ GRANT permissions

**Symptom**: Tables empty in Supabase dashboard despite hundreds of successful HTTP calls. Console shows `401 Unauthorized` and `permission denied for table X`.

**Cause**: The `anon` role had RLS policies allowing inserts, but lacked the underlying PostgreSQL table privileges.

**Fix**: Explicit `grant select, insert, update on TABLE to anon` for every table. Plus `grant usage on sequence X_id_seq to anon` for any auto-incrementing column.

**Two distinct error messages indicate two distinct layers**:
- `"permission denied for table X"` → GRANT layer (PostgreSQL-level)
- `"violates row-level security policy"` → RLS layer (Supabase-managed)

Both must pass for a write to succeed.

### 2. Broadcast first-call race

**Symptom**: First call after a fresh game-start was sometimes invisible to students; subsequent calls worked fine.

**Cause**: Teacher's first `pushCall` happened while students were still in the middle of subscribing to the channel. Phoenix channels don't replay messages to clients that subscribe after the send.

**Fix**: Added the explicit **lobby phase**. Teacher creates room with `status='lobby'`, students join and subscribe during the wait. Teacher's "Start Calling" button broadcasts a `start` event AFTER everyone's subscribed. Calls only fire after that. Late joiners catch up via DB replay (`Net.joinRoom` returns `recentCalls`).

### 3. `deploy.bat` overwrites root `index.html`

**Symptom**: Edits to `E:\Claude Code Projects\Mr.D\index.html` silently disappear on next deploy.

**Cause**: `deploy.bat` runs `copy /Y "Landing Page\index.html" "index.html"` as step 1. The root index.html is a build artifact.

**Implication**: If you ever edit the landing page (the "Expanse of the Universe" home page at `dhiya.id/`), edit `Landing Page\index.html`. **Sound BINGO at `unindra/sbg/index.html` is unaffected** — deploy.bat only touches the landing page + assets folder.

### 4. The single-file constraint

**Don't fragment.** ~2900 lines in one file. Trade-offs accepted in exchange for offline use, print-friendliness, zero build, AI-readability.

**When the file gets unwieldy**: use clearer section dividers (`/* ════════ NAME ════════ */`), not module extraction. CSS sections can use `/* ─── Subsection ─── */`.

### 5. Two channel objects on the same Phoenix channel

Both teacher and students have **two** `_sb.channel('room:XXXX')` objects — one via `_ensureBC` for sending, one via `subscribeRoomEvents` for receiving. Supabase deduplicates at the Phoenix layer; both work independently.

**Don't try to share a single channel object.** It complicates handler registration, tear-down, and the broadcast-self semantics (by default, your own broadcasts don't echo back — useful, but only when sender and receiver are separate channel instances).

### 6. Throttle progress emissions

Without throttle, rapid taps from a single student create a flood of broadcasts + DB upserts. `Player._emitProgress` is throttled at 300ms — last-write-wins, but `markedIds` always carries the full array so no individual mark is lost in a coalesced burst.

If you add another high-frequency event, throttle it. `throttle(fn, ms)` is at the top of the helpers section.

### 7. `Opts.setSpeed` scope leak

The Options modal has **two** `.speed-row` sections (Caller Speed + Reveal Delay). A naive global `document.querySelectorAll('.speed-btn')` deselects both. Use `btn.parentElement.querySelectorAll('.speed-btn')` to scope the selection.

This pattern applies anywhere you have multiple instances of the same component on one screen.

### 8. Room-level vs client-level settings

Some settings live on the **room** (propagated to students via `joinRoom`):
- `strict_marking`
- `highlight_tappable`
- `win_condition`
- `enabled_cats`
- `guaranteed_sounds`

Other settings are **teacher-only** (local `St` state):
- `callSpeed`
- `autoReveal`, `autoRevealDelay`
- `teacherMode`

**Rule**: if it affects student-side behavior, propagate it via the room row. If it only affects the teacher's caller UI, keep it client-local.

This wasn't always the case — early versions had `St.strictMarking` and `St.highlightTappable` as teacher-only, which meant the toggle did nothing for students. Lesson: think about whose UI is affected, then place state accordingly.

### 9. Solo and Player share the win-check shape

`Player._checkWin(gs)` and `Solo._checkWin(gs)` return identical shapes: `{type, lines, cells}` or `null`. When extending win logic (new condition, new animation), update **both** in lockstep. Same for `FX.celebrate` dispatch.

### 10. cardId stability across `newCard()`

`Player.cardId` is generated **once per session** (set to `''` at the start of `applyCode`, only populated by `buildCard` if currently empty). Pressing 🔄 (`Player.newCard`) rebuilds the layout but **reuses the same cardId** — same DB row gets upserted with a new layout + empty `marked`.

**Why it matters**: earlier behavior generated a fresh cardId on every `buildCard` call, so pressing 🔄 three times created three rows in `cards` table → three duplicate entries in the teacher's dashboard under the same name. With reuse, one student = one row, always.

**If you ever want a true "leave and rejoin" reset**: clear `Player.cardId=''` explicitly (e.g., on screen exit). The current code does this in `applyCode` so a fresh join starts clean.

### 11. Serialized card writes via Promise queue

All writes to the `cards` table (initial register + every progress upsert) go through `Net._queuedCardUpsert(payload)`, which chains them on `Net._cardWriteQ`. Why:

Without serialization, this race was possible:
```
buildCard fires Net.registerCard → INSERT (marked:[])  ─┐
user taps cell, _emitProgress fires Net.updateMarked   ─┤  CONCURRENT
                                                        │
If INSERT arrives at server AFTER UPDATE:               │
  → UPDATE finds no row, silently does nothing          │
  → INSERT writes marked:[] (wiping the mark)           ─┘
```

The 8s dashboard poll then reads `marked:[]` from DB and overrides the local "1/9" state with "0/9". Progress appeared frozen.

The fix: every card write is an UPSERT, and all writes are chained on a single Promise queue per client. Each write awaits the previous one's completion before firing. Last-fired-wins, deterministically.

### 12. Room cleanup / TTL system

Codes are only 4 digits (3,000 possible per difficulty since the first digit is fixed: `1xxx` easy, `2xxx` normal, `3xxx` hard). After a few hundred sessions, collisions are statistically inevitable. The failure mode: a teacher creates session `2746`, students join, but they're actually walking into a graveyard session from last month, complete with phantom calls being replayed from `Net.joinRoom`'s `recentCalls` array.

**Two-tier cleanup** ships in the SQL schema and `Net.createRoom`:

| Tier | When it fires | What it does |
|------|---------------|--------------|
| **Collision recycle** (automatic) | Every `Net.createRoom` call | RPC-invokes `purge_room_if_stale(code)` before INSERT. Function deletes the old row if and only if `(started_at IS NULL AND created_at < now() - 30 minutes)` OR `(started_at < now() - 4 hours)`. Cascade drops calls/cards/claims atomically. |
| **Periodic sweep** (manual) | Admin runs `select purge_stale_rooms();` in the SQL editor | Single-shot nuke of all rooms older than the threshold. Function is NOT granted to anon — only the postgres role can execute it. Run this every week or two during heavy classroom usage. |

The collision recycle is wrapped in `try/catch` so if the RPC is missing (e.g., on a stale schema), `createRoom` still works — it just falls back to the natural PK collision error.

**Active-room collision** (the edge case where the random code matches an actively-running session): `purge_room_if_stale` refuses to delete it, the INSERT fails with PG error 23505, `Net.createRoom` returns `{collision: true}`, and `Teacher.launch` retries with a fresh code (up to 5 attempts). Surface to the teacher only if all 5 fail — at which point the codespace is genuinely saturated and they should wait or change difficulty.

**Why `security definer` and not raw DELETE grants**: granting anon raw `DELETE` on `rooms` would let any client purge any session by ID. The function constrains the deletion to provably-stale rows only. Defense-in-depth, even in a low-stakes classroom context.

**Required SQL** (run once on the Supabase project):
```sql
alter table rooms add column if not exists created_at timestamptz default now();

alter table calls  drop constraint if exists calls_room_id_fkey;
alter table calls  add  constraint calls_room_id_fkey
  foreign key (room_id) references rooms(id) on delete cascade;
alter table cards  drop constraint if exists cards_room_id_fkey;
alter table cards  add  constraint cards_room_id_fkey
  foreign key (room_id) references rooms(id) on delete cascade;
alter table claims drop constraint if exists claims_room_id_fkey;
alter table claims add  constraint claims_room_id_fkey
  foreign key (room_id) references rooms(id) on delete cascade;

create or replace function purge_room_if_stale(p_room_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_started timestamptz; v_created timestamptz;
begin
  select started_at, created_at into v_started, v_created from rooms where id = p_room_id;
  if not found then return false; end if;
  if (v_started is null and v_created < now() - interval '30 minutes')
     or (v_started is not null and v_started < now() - interval '4 hours') then
    delete from rooms where id = p_room_id;
    return true;
  end if;
  return false;
end; $$;
grant execute on function purge_room_if_stale(text) to anon;

create or replace function purge_stale_rooms()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  with deleted as (
    delete from rooms
    where (started_at is null and created_at < now() - interval '1 hour')
       or (started_at is not null and started_at < now() - interval '24 hours')
    returning 1
  )
  select count(*) into v_count from deleted;
  return v_count;
end; $$;
-- purge_stale_rooms is intentionally NOT granted to anon.
```

The queue is per-tab (per Net instance), but since each tab only writes to its own cardId, this effectively gives us per-cardId serialization. Multi-student concurrency is handled by Supabase server-side.

If you ever add another write path on `cards`, route it through `Net._queuedCardUpsert` too. Don't bypass.

### 12. The vignette persistence trap

The one-time spotlight tooltips (`showVignette`) use `localStorage` to remember dismissal. Earlier versions only persisted on the explicit "Got it" link click — clicking the overlay just closed it temporarily, so users dismissed-via-overlay kept seeing it. Now **any interaction** (overlay click, hole click, tip click, X button, auto-timeout) marks it permanent. If you add a new one-time hint, follow the same any-interaction-dismisses pattern.

---

## How to Extend

### Adding a sound

1. Find the `SOUNDS` array (around line 1030).
2. **Order matters**: `soundsForDiff(diff)` uses array order to pick which sounds enter Easy/Normal/Hard. Convention: consonants first, then short vowels, then long vowels, then diphthongs.
3. Fields: `{id, label, name, category, tip, ex, words}`. `id` must be unique. `words` is the list the caller will speak. `ex` is for the Sound Guide (example words with highlighted letters).
4. If you exceed 24 sounds, the Hard mode (5×5 = 24 needed, with center FREE = 25) might need a rethink.

### Adding a category

This is more invasive:
1. Add to `St.enabledCats` default
2. Add a toggle in the Options modal (`<input id="tog-newcat">`)
3. Add color to `CAT_COLORS`
4. Add to the enumeration in `Opts.save`
5. Add to the categories array in `Teacher._buildGuarList`
6. Add a tab to the Glossary
7. Add to the Print card layout if styling is category-specific

### Adding a new screen

1. Add `<div id="new-screen" class="scr">…</div>` to the HTML body
2. Add a controller object in JS
3. Navigate via `UI.go('new-screen')`
4. Handle the topbar back button cleanly (any state cleanup needed)
5. Add to `Opts.adapt` if the screen has special Options visibility

### Adding a broadcast event

1. Define the payload shape (keep it small — broadcasts are sent to all subscribers)
2. **Sender**: `(await Net._ensureBC(roomId)).send({type:'broadcast', event:'your_event', payload})`
3. **Receiver**: extend `Net.subscribeRoomEvents` signature to accept `onYourEvent`, add the `.on('broadcast', {event:'your_event'}, ...)` handler
4. Wire the handler into the relevant module (Player / Teacher / Dashboard)

### Modifying win conditions

- Update `Player._checkWin(gs)` AND `Solo._checkWin(gs)` (kept in sync)
- Return shape: `{type, lines:[[indices]...], cells:[indices]}` or `null`
- Extend `FX.celebrate(win, gridId)` to dispatch on the new `type`
- Add the visual to the WinDemo briefing modal if it's user-facing

### Adding a per-room setting

1. New column on `rooms` (with a default for safety): `alter table rooms add column if not exists my_setting bool default true;`
2. Pass through `Net.createRoom` signature
3. Return from `Net.joinRoom`
4. Store on `Player` (e.g., `this.mySetting`) in `applyCode`
5. Read from `Player.mySetting` in the logic that uses it
6. (If teacher-configurable) add a toggle to Options modal + `Opts.save`

---

## Deployment

### Layout

```
E:/Claude Code Projects/Mr.D/
├── index.html                  # ⚠️ BUILD ARTIFACT — overwritten by deploy.bat
├── deploy.bat                  # deploy script
├── Landing Page/
│   ├── index.html              # source of truth for the LANDING page
│   └── assets/                 # landing-page-specific assets
├── unindra/
│   └── sbg/                    # ← this project
│       ├── index.html          # the entire app
│       └── README.md           # this file
├── fireplace/                  # unrelated project
├── graduation/                 # unrelated project
└── lab/                        # unrelated project
```

### `deploy.bat` behavior

1. Copies `Landing Page\index.html` → root `index.html` (overwrites!)
2. xcopies `Landing Page\assets\` → root `assets\`
3. Pushes to Vercel

**Sound BINGO is not touched** — it lives at `unindra/sbg/` which Vercel serves directly via folder routing. Edits to `unindra/sbg/index.html` go live on the next deploy without any copy step.

### Schema migrations

There's no migration system. When a feature needs a schema change:
1. Document the SQL in this README (under the feature's section AND the [Data Model](#data-model) table)
2. The user runs it manually in Supabase SQL Editor
3. The code uses `add column if not exists` patterns so re-runs are safe

### Vercel config notes

- `cleanUrls: true` (`/unindra/sbg` works without `.html`)
- Static hosting only — no serverless functions in this app

---

## Deferred Work / Known Limitations

These were intentionally NOT shipped in the current iteration. Priorities can shift; this list is the candidate pool.

| # | Item | Notes |
|---|------|-------|
| 1 | **End-of-round flow** | Currently when one student wins, the caller keeps calling. Need an "End Round" button + "Round 2" reset. Probably wants `rooms.status='ended'` + a teacher-side modal. |
| 2 | **Card persistence across refresh** | Student refreshes → new card. Could persist `cardId` to `localStorage` keyed by room, then `Net.fetchCard(cardId)` to restore layout + marked state. |
| 3 | **Real Supabase Presence** | Current student count uses 8s polling of cards table. Real presence (`channel.track` / `channel.presenceState`) would be faster but requires more wiring. |
| 4 | **Per-student progress drill-down** | Clicking a dashboard row could show the full IPA grid showing which sounds were marked when. The current dots-grid is intentionally compact for scale. |
| 5 | **Multi-room teacher** | `St.sessionCode` is singular. One teacher can't run two simultaneous rooms. Would need a room switcher. |
| 6 | **Teacher reconnect** | If teacher refreshes mid-game, room state is lost client-side. Could rehydrate from `rooms` + `calls` tables on the matching code. |
| 7 | **i18n** | UI strings are English-only. SOUNDS dataset is English phonemes. |
| 8 | **Mobile teacher** | Caller-screen is desktop-optimized. Cramps on phones. |
| 9 | **Caller filler determinism** | Each `LobbyT.start` picks random fillers. Two refreshes give different filler sets. Could persist filler set in the room row. |
| 10 | **IPA toggle on dashboard** | Currently dots only. Could add a toggle to show IPA labels for teachers who want to spot patterns ("most students don't have /θ/ marked yet"). |
| 11 | **Automated `purge_stale_rooms` cron** | Collision recycle is automatic (per-call via `purge_room_if_stale`), but the bulk sweep is manual — admin runs `select purge_stale_rooms();` in the SQL editor. Could wire to `pg_cron` (Supabase supports it via the dashboard) to run nightly, but that requires enabling the extension first. For now, manual sweeps every 1-2 weeks during active classroom usage is fine. |
| 12 | **Larger code space** | 4 digits with the first locked to difficulty = 3,000 codes per difficulty. Heavy long-term usage could exhaust them. Stretching to 5 digits (30,000 per difficulty) gives ~10× headroom but trades off student typing friction. The cleanup system delays this need significantly. |

---

## File Map

```
unindra/sbg/
├── index.html      # the entire app (~2900 lines)
└── README.md       # this file
```

Inside `index.html` (top-to-bottom approximate sections):

```
Lines     Section
─────     ───────────────────────────────────────
1–8       <head>, fonts, Supabase client CDN
9–360     <style> — all CSS (~350 lines)
361–1023  <body> — all HTML markup (home, setup, lobby, caller, card-screen,
          solo, print, options modal, sound guide, win briefing, etc.)
1024–2710 <script> — main app logic
  1030–1133  SOUNDS data array (24 phonemes)
  1135      GRID_SIZE, GRID_COUNT constants
  1138      Pseudonym wordlists + helpers
  1146      St (state object)
  1175–1195 soundsForDiff, callerSoundsFor, helpers
  1197–1290 UI module
  1297–1379 Opts module
  1382      Net module (Supabase calls)
  1500–    Teacher, LobbyT, Caller, Player
  ...       Solo, Print, FX, Dashboard, vignette, Home
2729–2770 <script> #2 — Glossary + URL-param dashboard boot
```

---

## Changelog Highlights

Recent shipped milestones, most recent first. Granular commit history lives in the repo's git log (when applicable).

### Iteration: Dashboard polish (current)
- **cardId stability**: pressing 🔄 (newCard) now reuses the same cardId → one DB row per student, no more duplicate "Brave Heron" entries in the dashboard
- **LIVE tab as flag**: tab now hangs off the outside-left edge of the sidebar; when collapsed, sidebar slides fully off-screen and only the gold tab remains visible at the viewport edge (no more "license plate" look)
- **Serialized card writes**: all `cards` upserts queued through `Net._cardWriteQ` to eliminate the registerCard-vs-updateMarked race (which was wiping marks back to `[]`); `Net.upsertCardProgress` replaces `Net.updateMarked`
- **Broadcast send awaited**: `Net.broadcastProgress` now awaits `ch.send` and logs non-`ok` results so silent broadcast failures become visible

### Iteration: Live dashboard
- Player names + 🎲 pseudonym randomizer
- Throttled progress broadcast + DB persistence
- Right-side collapsible **Live Board** sidebar on caller-screen with sorted student rows and dot-grid mini-cards
- Pop-out dashboard window via `?dashboard=ROOMID` URL param
- Schema: `cards.display_name`, `cards.marked`

### Iteration: Caller-queue guarantees + Print transparency
- `callerSoundsFor(diff)` — caller queue now respects guarantees (was student-card-only before)
- Difficulty downgrade clears guarantees that no longer fit, with alert
- Print mode rewrote to bake guarantees into every printed card
- Print preview now has a transparency banner listing locked-in sounds + filler count
- "🎲 Shuffle positions" button on print-screen for re-rolling layouts

### Iteration: Hard-include sounds + Tappable everywhere
- Guaranteed sounds picker in Setup (per-category chip grid, count cap = grid_count)
- Help mark "?" with explanation alert
- All cells tappable; wrong tap shakes, correct tap marks gold (not category color)
- Highlight Tappable toggle (room-propagated)
- WinCondition propagation fixed (was reading from local St instead of room)
- Strengthened armed/dimmed visuals

### Iteration: Lobby + Strict marking + Now Calling polish
- Lobby phase for sync: teacher creates `status='lobby'` room, students join + subscribe, Start Calling broadcasts `'start'` event
- Strict marking mode (only most-recent call armed) vs forgiving
- Highlight Tappable toggle
- Two Lines + Full House win animations (multiple SVG lines + golden rectangle + sparkles)
- Now Calling panel + student-side called-history strip
- "Not on your card" indicator when called sound isn't on student's grid
- Game-of-chance disclaimer (home footer + How-to-Play modal)
- Vignette dismiss fixed (any interaction = permanent dismiss)

### Iteration: Multiplayer foundation
- Supabase project setup, anon-key in HTML
- Lessons learned: RLS vs GRANT, Realtime publication for `claims`
- Broadcast wiring for calls (replaced Postgres Changes for <100ms latency)
- Late-joiner replay via `Net.joinRoom`'s `recentCalls`
- Now Calling panel on student card
- First architectural notes captured in memory

### Iteration: Opus 4.7 architecture pass
- Multi-step plan: rooms = sessions, append-only calls = source of truth, server-authoritative BINGO verification, students join no-auth via room code
- Net module abstraction
- Initial schema: rooms, cards, calls, claims

---

**This document is the project's source of architectural truth.** When something here gets out of sync with `index.html`, update this file first, then the code. Future-you (or the next AI agent) will thank you.
