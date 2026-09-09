# centi.gg — Handoff

**Date:** 10 September 2026 (evening)
**Owner:** Craig Muirhead (New Zealand)
**Live:** https://centi.gg (HTTPS, certificate issued, Enforce HTTPS on)
**Repo:** github.com/masterblasterzzz/centi-game (public, `main`, GitHub Pages from root)
**Server:** https://centi-server.fly.dev (Fly.io, region `syd`, app `centi-server`)
**Analytics:** PostHog US cloud, https://us.posthog.com

---

## How to work on this with Craig — READ FIRST

**Craig has Claude in Chrome installed and set up, and we have used it together before.**
Use it. It is the right tool for this project: the game is a live 3D page with a network layer,
and photos of a monitor are a poor substitute for seeing the tab.

Working loop that suits him:

1. Open centi.gg in Chrome via the extension, hard-reload (Cmd+Shift+R — Pages caches scripts
   for ~10 min and this has bitten us every single time), and watch him play.
2. Read the console for errors; use `read_page` / `javascript_tool` to inspect live state:
   `net` (the CentiNet instance), `net.serverT`, `net.renderT`, `world.snakes`, `me()`.
3. Reproduce what he describes before changing code. Several "bugs" this week were browser cache.
4. Fix in the smallest file possible. `net.js` (13 KB) and `sim.js` (22 KB) are cheap to push;
   `client.js` (52 KB) is expensive — give Craig a `sed` one-liner to run locally for one-line
   changes there instead of re-pushing the whole file.
5. Every server-side change (`server.js`, `sim.js`) needs Craig to run
   `cd ~/centi-game && git pull && fly deploy`. Client-only changes just need a hard-reload.

Chrome gotchas learned 10 Sep:

- **Only one Claude can hold the extension at a time.** If Craig has the Claude side panel open in
  Chrome, that session owns the browser and this session's tab group silently disappears
  (`tabs_context_mcp` → "No tab group exists"). The split that works: Craig plays with the side-panel
  Claude watching the live tab, and this session does code reading, fixes and the handoff. Don't fight it.
- **A hidden tab renders zero frames.** Chrome stops `requestAnimationFrame` in background tabs, so
  the client stops sending input and predicting; the server keeps moving you (straight, at base speed)
  until you die. Any state you read from a hidden tab is junk. Bring the window to the front first.
- `net`, `player`, `world`, `mouse`, `camera` are top-level `let`/`const`, **not** on `window` — in
  `javascript_tool` use the bare names, never `window.net`.

Craig is direct, ADHD/dyslexic, prefers short messages and honest pushback, and is comfortable in
Terminal (zsh on an iMac). He types in caps a lot; it's not shouting.

---

## What it is

A slither-style .io game where centipedes crawl the surface of a 3D globe. Portals at the poles
teleport you to the antipode (and sever your tail if they close mid-jump), ten sinkholes and two
wandering storms pull you in, nine bots in three tiers fill the world. Solo mode runs entirely in the
browser; online mode joins a shared globe on a Sydney server with up to 40 players per room.

Built in three.js r128 from CDN. No build step, no framework.

---

## Files in the repo

| File | Role |
|---|---|
| `index.html` | Shell: head/SEO metadata, CSS, menu markup, PostHog snippet, "× Back to the menu" escape, loads the three scripts |
| `sim.js` | **The rules.** Movement on the sphere, bots, food, jelly, portals, hazards, collisions. Runs in browser (`window.CentiSim`) and Node (`module.exports`). The server and client share this file. |
| `net.js` | Client network layer: WebSocket, mirrors the server world, interpolates other players, predicts own player, converts server time → browser time |
| `client.js` | Rendering, input, sound, UI, camera, minimap, analytics events |
| `server.js` | Authoritative server: rooms, 20 Hz tick, snapshots, bot top-up, sanitised names/looks |
| `fly.toml`, `Dockerfile`, `package.json`, `.dockerignore` | Fly.io deploy |
| `DEPLOY.md` | Server deploy instructions |
| `CNAME` | `centi.gg` for GitHub Pages |
| `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `llms.txt` | SEO / AI-crawler / PWA |
| `og.png`, `icon-512.png`, `icon-180.png` | Social card and icons (uploaded manually) |
| `README.md`, `HANDOFF.md` | This file and the readme |

---

## Architecture decisions (don't undo these)

- **Sphere movement uses no lat/lon.** Head = unit vector `p`, heading = tangent `h`. Move by rotating
  `p` about `p × h`; steer by rotating `h` about `p`; re-orthonormalise every frame. Body = breadcrumb
  trail at fixed arc length `SEG`. Lat/lon has pole singularities; this doesn't.
- **Sim/render split.** `sim.js` has no rendering dependencies. The server runs it headless in Node.
  A minute of nine bots simulates in ~1 s (60× realtime), so a server tick is cheap.
- **Server is authoritative.** Clients send only steering + boost. Nobody can cheat by editing their browser.
- **Client-side prediction for your own centipede** (`net.predictSelf`): runs the real rules locally
  from your input so steering is instant, then eases onto the server's extrapolated truth. Errors under
  7 units are ignored (correcting them caused wobble); over 60 units it snaps (portal jump, lag spike).
- **Other players are interpolated** `lag` seconds behind the server (currently 0.11 with 20 Hz
  snapshots; must be ≥ ~1.5 snapshot intervals). The render clock runs slightly fast/slow to hold that
  gap — never clamped to server time (that pinned it to the newest snapshot and caused wobble).
- **Every server timestamp is converted to browser time on arrival** (`local()` in `net.handle`).
  The server clock counts from room creation; the browser's from page load. Missing this hid all the
  food online. Any new server-sent time must go through `local()`.
- **Portal jumps online are the server's call.** The prediction holds you just inside the ring
  (`PORTAL_R - 1.5`) for at most 0.35 s until the server's snapshot shows you at the far pole, then
  snaps once and fires the client's `portal` event itself (camera snap + sound on the right frame).
  The server's own `portal` event for you is filtered out. Jumping locally caused ping-pong; an
  unbounded hold caused a sticky head when the server's copy grazed the ring and missed.
- **Pellets are eaten optimistically**: the client hides a pellet the moment your predicted head touches
  it (`respawnAt = now + 0.7`); the server's `food` event overwrites with the real respawn time, or the
  pellet comes back. Waiting for the server made pellets vanish from under your body or not at all.
- **Views are bound to snake objects, not ids.** Local and server worlds both number snakes `s1, s2…`;
  when the server world replaces the local one, views must be rebuilt (`syncViews` checks `s !== v.snake`).
  Forgetting this made your own centipede invisible online.
- **Camera "up" is a parallel-transported tangent (`camUpRef`)**, never the heading and never the surface
  normal when looking straight down. Both caused spinning.
- **Menu:** live world runs behind the card, your centipede parks at spawn under a fixed camera.

---

## Key constants

`sim.js` → `C`: `R=340` · `SEG=2.1` · `MAX_SEG=1600` · `BASE_SPEED=48` · `TURN=4` (turn radius ≈ 12) ·
`STEER_EASE=7` · `HIT_R=3.1` · `FOOD_N=250` (10 boost) · `HOLE_N=10, HOLE_R=9` (kill radius `HOLE_R` after the 10 Sep pm fix; was `HOLE_R*.9`) ·
`STORM_N=2, STORM_R=22` · `PORTAL_R=12`, cycles `[20 open/8 closed]` and `[18/10, phase 13]` ·
`GRACE_LEN=30, GRACE_SECS=20` (bots don't hunt newcomers).

`server.js`: `TICK=1/20`, `SNAP_HZ=20` (Craig changed from 10 — verify with `grep SNAP_HZ server.js`
and that `fly deploy` ran), `ROOM_CAP=40`, `MIN_POP=10`, `IDLE_MS=60000`.

`net.js`: `lag=0.11`, prediction dead-zone 7 units, snap threshold 60 units, portal hold 0.35 s.

`client.js`: `SERVER_URL='wss://centi-server.fly.dev'`, default `userZoom=.95` (persisted as
`centi.zoom`), sinkhole horizon cull `+ .14` (was `.02`; Craig applies via sed — check it landed),
`mouse.moved` gate — cursor steering is ignored until the mouse moves after a spawn (see 10 Sep pm).

---

## Infrastructure status

| Thing | State |
|---|---|
| Domain centi.gg | Porkbun. 4 A records → GitHub Pages IPs, `www` CNAME → masterblasterzzz.github.io, Google TXT verification |
| HTTPS | Certificate issued after ~24 h (GitHub-side delay). Enforce HTTPS ticked |
| GitHub Pages | Deploys from `main` root. Browser caches scripts ~10 min — **always Cmd+Shift+R after a push** |
| Fly.io | Deployed from `~/centi-game` on Craig's iMac via `fly deploy`. Machines auto-suspend when idle and wake on connect. `curl https://centi-server.fly.dev/health` → `{"ok":true,"rooms":N,"players":N}` |
| Search Console | Domain property verified; sitemap submitted. Bing: import from GSC (may not be done) |
| PostHog | Events: `run_start` (mode), `run_end` (reason, killer, length, kills, seconds, portals), `kill`, `watch`, `share`, `online_failed` (reason). Billing cap should be $0 (check) |
| Social card | og.png in repo. iMessage cached a broken preview from the cert-invalid period; test with `?v=N` |

**Redeploying the server** (after changes to `server.js` or `sim.js`):
```
cd ~/centi-game && git pull && fly deploy
```
The Docker image only copies `server.js` and `sim.js`.

**Craig's terminal:** flyctl at `~/.fly/bin`, PATH in `~/.zshrc`, logged in as transformer_film@xtra.co.nz.
macOS sed needs `sed -i ''`.

---

## Open issues (as of 10 Sep, evening)

1. **Verify two fixes landed** (Craig applies both via sed, see session log):
   - *stale-cursor spawn turn* — client.js, `grep -c "mouse.moved" client.js` → 7, hard-reload.
   - *sinkhole kill radius* — sim.js, `grep -c "HOLE_R \* .9" sim.js` → 0, then `fly deploy`.
2. **Verify the earlier round**: pellets vanish on touch, no sticky head at a pole, no dark sinkhole
   cones on the horizon, server at 20 Hz (`grep SNAP_HZ server.js`).
3. **"Connecting…" freeze** before an online run: your parked centipede is shown but can't move until
   the server's `full` arrives, and the Fly machine can take seconds to wake. Fix is infra
   (`min_machines_running = 1` in `fly.toml` while there are testers) or UX (keep the menu card up
   until `onOpen`).
4. **Pale jelly along the player's own path** — most likely leftover jelly from a previous death/sever
   on the same route, but confirm it isn't a spurious sever/death on the server (watch `ev` messages
   for `jellyAdd` with the player's colour while alive).
5. **Body pass-through with other players** — inherent to prediction + lag; reduced by 20 Hz / 0.11 s.
   If still bad, consider server-side lag compensation for head-vs-body checks.
6. **Not yet tested with two real humans on the same globe.** (A test client from this session joined a
   room with 7 bots and no Craig — check `pickRoom` puts humans together rather than opening new rooms.)
7. **Mobile / cellular** online play untested.
8. **iMessage preview** shows favicon instead of og.png — likely cached from before HTTPS worked.

## Roadmap (agreed order)

1. **Get 5 real testers on centi.gg online.** Watch PostHog: survival times, return visits, `online_failed` reasons.
2. Fix whatever they hit. Balance from data, not guesses.
3. **Promotion:** clips (Craig's strength — cinematic mode `V`), small/mid gaming creators (10k–200k)
   with no ask, portal submissions (**CrazyGames, Poki** — they run ads and pay rev share, biggest
   revenue lever at this stage), one coordinated Reddit + Show HN burst.
4. **Revenue:** one rewarded video on the death screen ("watch to respawn at half length") — the only
   ad on centi.gg itself. No banners. Cosmetics (skins, trails, name colour) after multiplayer is proven;
   needs accounts + Stripe. Later: a supporter purchase that removes ads.
5. **Rocket towing an advertising banner across the sky** — Craig's idea; better than billboards on the
   terrain (off the playfield, charming even with no sponsor). Build after there are players; use it
   for self-promotion first.
6. Cloudflare in front of Pages when traffic warrants (DDoS + caching).
7. Touch follow-finger steering (currently left/right halves).
8. Search Console / Bing check-in once indexed.

---

## Legal notes

- "Centipede" is an Atari trademark — never title it that. "centi" is fine.
- slither.io mechanics aren't copyrightable; don't use "slither" in marketing copy.
- Not affiliated with either; the About section says so.

---

## Session log

**8–9 Sep:** menu camera spin fixed (fixed camera, live world behind); domain, DNS, HTTPS, Search
Console, sitemap, SEO/AEO metadata, JSON-LD, llms.txt; sim/render split (`sim.js` + `client.js`),
proved headless in Node; Fly.io server built and deployed; client network layer; Play online.
Fixed: stuck-on-Connecting (timeout + escape button), invisible own centipede (stale views),
side-to-side wobble (render clock), zig-zag steering (client prediction), portal ping-pong
(server-authoritative portal), portal rings not cycling online, no food online (server→browser time
conversion), portal camera glitch (snap on the right frame). Default zoom widened and persisted.

**10 Sep:** screenshots confirmed the sinkhole-shaft artifact (horizon cull tightened); optimistic
pellet eating; bounded portal hold (sticky head at a pole); 20 Hz snapshots + 0.11 s lag (Craig
applied). Handoff updated to lead with the Claude-in-Chrome workflow.

**10 Sep (pm):** Craig reported "head bent left and sticky as soon as I started" online. Diagnosis from
the code (the live tab was owned by the side-panel Claude): the cursor is still where *Play online* was
clicked; online you spawn at a random point, the camera snaps there with an arbitrary roll, and
follow-cursor steering yanks you toward the stale cursor until the heading lines up (in solo the spawn is
under the menu camera, so it doesn't show). The client also sends that steer to the server before `full`
arrives. Fix: `mouse.moved` flag — set false in `goOnline`, `startRun` and both respawn buttons, set true
in `pointermove`, required by the `mouseSteer()` call. Client-only. The "sticky" part is the
Connecting… freeze (issue 3). Also handed Craig the sinkhole fix: kill at `HOLE_R` (9, the shaft edge)
instead of `HOLE_R * .9` (8.1) in `sim.js` `inHole` and the pull inner radius — server change.
