# Lessons for the game engine

Generalisable lessons from building centi.gg, written for the bigger task that follows it: a
game-creation engine. **Both Claude sessions (side-panel and Cowork) read and append to this file and
to `HANDOFF.md`.** Keep entries as rules with the evidence that earned them; centi-specific bug
history stays in `HANDOFF.md`.

Format: one `##` per lesson. Date, the rule, why (with numbers where we have them), and what it
means for the engine.

---

## Split the simulation from the rendering on day one (8–9 Sep 2026)

Rule: the rules module has no rendering dependency and runs headless in Node.
Why: it is what made a server possible without a rewrite, and it is what let every networking fix
below be proven in a headless test before pushing (a fake 70 ms link, hard circles, 12 s of play, in
under a second). A minute of nine bots simulates in ~1 s.
Engine: every game template ships as `sim` + `render` + `net`, and the sim must be loadable from a
Node test with no DOM.

## Never compare a prediction against the server extrapolated to "now" (10–11 Sep 2026)

Rule: client-side prediction reconciles like for like — number every input, have the server echo the
last input number it applied, compare the server's state against the client's own history entry for
that same input, and on a mismatch restart from the server's state and replay the inputs sent since.
Why: extrapolating the server's last sample forward and comparing with the present head disagrees by
design in every turn (the server runs ~140 ms behind the hand). Measured on centi.gg: heads 6.9 units
apart on average, peaks 29, a correction on 27% of frames, and deaths at places the player never saw
themselves go. With replay reconciliation: 0.42 units average, p95 1.5.
Engine: reconciliation is a library primitive, not per-game code. It needs: an input sequence number
in the input message, `appliedSeq` per player in the snapshot, a bounded input history (~4 s), and a
deterministic `step(state, input, dt)` in the sim.

## Corrections are a visual offset that fades, never a rigid rotation applied to the present (11 Sep 2026)

Rule: keep two things — the prediction (authoritative on the client, corrected by replay) and a purely
visual offset between it and what is drawn, which decays over ~100 ms.
Why: the first attempt applied the rotation "old predicted point → server point" to the *current*
head. On a curve a sideways error 45° back becomes a forward/backward shove now; measured as the head
moving at 1.09 units/frame in a circle and 0.6 in a straight instead of 0.8. Replay + fading visual
offset gave frame-step jitter 0.037 (old code 0.095).
Engine: the offset lives in the render layer as a transform between "sim truth" and "drawn", so it
works for any entity type.

## Client and server must integrate with the same step size (11 Sep 2026)

Rule: the sim sub-steps `move()` into slices no longer than the client frame (1/60 s), so a 20 Hz
server tick is three identical slices.
Why: one Euler step per call at 50 ms vs 16.7 ms traces slightly different arcs in a turn (~1.2 units/s
apart). Reconciliation then corrects a drift that should not exist — visible as a side-to-side sway of
the head every ~0.5 s. Sub-stepping: jitter 0.037 → 0.013, server-vs-seen 1.42 → 0.88.
Engine: fixed-slice integration inside the sim, independent of who calls it and at what rate.

## Give humans slack where the server judges a touch (10 Sep 2026)

Rule: any "did the head touch X" check the server makes for a human gets a tolerance at least as wide
as the prediction error budget; bots stay exact.
Why: the client hid a pellet on touch, the server's copy passed wide, the pellet came back 0.7 s later:
"food respawns and I don't grow". 11 touched / 8 confirmed before, 16 / 15 after a 4-unit slack.
Engine: `eatSlack`-style per-check tolerances are a server config knob, applied to humans only.

## Every server timestamp is converted to client time on arrival (9 Sep 2026)

Rule: the server's clock starts at room creation, the browser's at page load; convert at the network
boundary, once, in one function.
Why: missing this hid all the food online (respawn times were "in the future" forever).
Engine: the net layer owns a `local(serverT)` and nothing else may store a raw server time.

## Losing the server must rebuild the local world, not just flip a flag (10 Sep 2026)

Rule: on disconnect, tear down the mirrored server world and rebuild the local one before showing any
menu; do not rely on a state flag that another handler may already have cleared.
Why: `onClose` cleared `online` first, the menu code then skipped the rebuild, and the loop stepped
the server's world locally with the player's own entity orphaned outside it — frozen, invisible, no
menu, only a reload got out.
Engine: world ownership is explicit (`world.owner = 'local' | 'server'`) and the menu asserts it.

## Interpolate others behind the server, and never clamp the render clock (9 Sep 2026)

Rule: draw remote entities `lag` seconds behind the newest snapshot (≥ ~1.5 snapshot intervals; 0.11 s
at 20 Hz) and let the render clock run slightly fast/slow to hold that gap.
Why: clamping to server time pinned the display to the newest snapshot, so heads jumped 10–20 times a
second and every centipede wobbled.

## Portal-style teleports are the server's call (9–10 Sep 2026)

Rule: the client holds at the mouth (bounded, 0.35 s) until the server puts it through, then snaps
once and fires its own teleport event on that frame.
Why: jumping locally ping-ponged; an unbounded hold left a sticky head when the server's copy grazed
the edge and missed.
Engine: any discontinuous move (teleport, respawn, knockback) is a server event the client waits for,
with a bounded hold.

## Measure before changing code, and measure from inside the running page (10–11 Sep 2026)

Rule: hook the net layer in the live tab (`javascript_tool` on `net.handle`) and count — packets,
events, prediction error, per-frame head step — before touching anything. Several reported "bugs"
were browser cache; the real ones all showed up as numbers first.
Engine: ship a debug overlay in the net layer that exposes exactly these counters, so a tester (or a
Claude watching the tab) can read them without instrumenting by hand.

## Benchmark competitors from the outside only (11 Sep 2026)

Rule: packet rates, sizes and timing via a WebSocket wrapper, plus screenshots — never read their code,
never decode their packets. Same rule as not lifting code.
What it gave us (slither.io): ~70 server packets/s of median 6 bytes (~1.2 KB/s) as per-entity
deltas; client input 18.5/s, 1 byte, sent on change; corpse orbs on the death frame; no zoom-out until
~200 length; boosting doubles speed and turn radius, not turn rate. Full table in `HANDOFF.md`.
Engine: delta snapshots belong in the net layer's defaults, and so does input-on-change — but only
with time-stamped inputs. With frame-numbered inputs (what centi.gg's reconciliation uses), dropping
unchanged frames leaves the server holding a stale `q` while the client's counter runs ahead, and
every snapshot reconciles against a ~100 ms-old frame (~5 units): the wobble comes back. Rejected for
centi.gg on 11 Sep for that reason; the design targets above are the bar for "feels like a real .io game".

## Costs should become opportunities for other players (11 Sep 2026)

Rule: when a mechanic charges the player (boost, teleport, damage), the thing they lose goes back
into the world where someone else can take it.
Why: centi.gg's boost cost was a flat 2.2 length/s that vanished — ~4× cheaper than slither.io at
length 200 (measured ~9/s there, dropped as orbs behind the tail) and it fed nobody, so chasing a
booster was never worth it. Now `max(2.2, 4 %/s)`, each 2 length lost becomes one jelly at the tail.
Dropped in `world.step`, never inside `Snake.move`, so client prediction (which also calls `move`)
cannot spawn jelly of its own. Headless: 10 s at 200 → 38 jelly, none self-eaten.
Engine: side effects that create world objects live in the world tick, not in per-entity movement.

## Visuals and rules share one constant (10 Sep 2026)

Rule: the renderer reads every radius, speed and threshold from the sim's constants table; it never
carries its own numbers.
Why: the sinkhole rim was drawn at radius 9 with a 1.3 tube (outer edge ≈ 10.3) while the kill check
used 9 × 0.9 = 8.1 → "killed before I hit the sinkhole". Fixed by killing at the drawn edge.

## Input must not survive a scene change (10 Sep 2026)

Rule: reset input state on every spawn and require fresh input before acting on it.
Why: the cursor position from the *Play online* click was still live when the camera snapped to a
random spawn point with an arbitrary roll; follow-cursor steering yanked the centipede into a turn on
frame one ("head bent left as soon as I started"). Solo never showed it because the spawn sits under
the menu camera. Fix: `mouse.moved`, cleared in `goOnline`, `startRun` and both respawn paths.

## Spend the spec on architecture, not features (from Roger Torres, "Building a Multiplayer Risk Game with Claude")

Rule: the architecture doc — single source of truth for live state, one broadcast path, who owns which
cache, pure state transitions — is written *before* the first feature, and every bug caused by a missing
rule is added back to it as a rule plus the failure it prevents.
Why: Torres's domain logic (rules, state machine) worked first time in ~200 lines; his real-time sync
layer took ~800 and broke in production with a second human — projections used as live state, async
double-apply, a race in his event stream. Claude knew the rules of Risk; it could not infer his cache
coherence. centi.gg's own history is the same 200/800 split: every fix on 8–11 Sep was in the sync
layer, none in the rules. His other lessons we already follow: pure sim (no `Date.now()` inside state
transitions), one truth path (server world → `snap`/`ev` → the same objects the renderer draws), and
testing with two clients from hour one — the last of which centi.gg has **still not done** (HANDOFF
open issue 6).
Engine: `ARCHITECTURE.md` is a required file in every game template and its "don't undo these" list is
seeded from `HANDOFF.md`'s.

## Two Claude sessions, one repo (10–11 Sep 2026)

Rule: only one Claude can hold the Chrome extension; the side-panel session watches the live tab and
measures, the Cowork session reads code and writes fixes and docs. They cannot see each other's chats —
the repo (`HANDOFF.md`, this file) and the GitHub commit log are the only shared memory, so every
session `git pull`s (or re-fetches the file SHA) before editing and writes its findings down before
stopping. A hidden Chrome tab renders zero frames, so any live reading from a background tab is junk.
