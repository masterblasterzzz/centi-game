# centi.gg — Handoff

**Date:** 9 September 2026
**Owner:** Craig Muirhead (New Zealand)
**Live:** https://centi.gg (HTTPS, certificate issued, Enforce HTTPS on)
**Repo:** github.com/masterblasterzzz/centi-game (public, `main`, GitHub Pages from root)
**Server:** https://centi-server.fly.dev (Fly.io, region `syd`, app `centi-server`)
**Analytics:** PostHog US cloud, https://us.posthog.com

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
| `index.html` | Shell: head/SEO metadata, CSS, menu markup, PostHog snippet, loads the three scripts |
| `sim.js` | **The rules.** Movement on the sphere, bots, food, jelly, portals, hazards, collisions. Runs in browser (`window.CentiSim`) and Node (`module.exports`). The server and client share this file. |
| `net.js` | Client network layer: WebSocket, mirrors the server world, interpolates other players, predicts own player |
| `client.js` | Rendering, input, sound, UI, camera, minimap, analytics events |
| `server.js` | Authoritative server: rooms, 20 Hz tick, 10 Hz snapshots, bot top-up, sanitised names/looks |
| `fly.toml`, `Dockerfile`, `package.json`, `.dockerignore` | Fly.io deploy |
| `DEPLOY.md` | Server deploy instructions |
| `CNAME` | `centi.gg` for GitHub Pages |
| `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `llms.txt` | SEO / AI-crawler / PWA |
| `og.png`, `icon-512.png`, `icon-180.png` | Social card and icons (uploaded manually) |
| `README.md` | Project readme |

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
- **Other players are interpolated** ~0.18 s behind the server so there's always a pair of snapshots
  to blend between. The render clock runs slightly fast/slow to hold that gap — never clamped to server
  time (that pinned it to the newest snapshot and caused the side-to-side wobble).
- **Portal jumps online are the server's call.** The prediction holds you at the portal mouth until the
  server's snapshot shows you at the far pole, then snaps once. Jumping locally caused ping-pong.
- **Views are bound to snake objects, not ids.** Local and server worlds both number snakes `s1, s2…`;
  when the server world replaces the local one, views must be rebuilt (`syncViews` checks `s !== v.snake`).
  Forgetting this made your own centipede invisible online.
- **Camera "up" is a parallel-transported tangent (`camUpRef`)**, never the heading and never the surface
  normal when looking straight down. Both caused spinning.
- **Menu:** live world runs behind the card, your centipede parks at spawn under a fixed camera.

---

## Key constants (`sim.js` → `C`)

`R=340` globe radius · `SEG=2.1` · `MAX_SEG=1600` · `BASE_SPEED=48` · `TURN=4` (turn radius ≈ 12) ·
`STEER_EASE=7` · `HIT_R=3.1` · `FOOD_N=250` (10 boost) · `HOLE_N=10, HOLE_R=9` · `STORM_N=2, STORM_R=22` ·
`PORTAL_R=12`, cycles `[20 open/8 closed]` and `[18/10, phase 13]` · `GRACE_LEN=30, GRACE_SECS=20`
(bots don't hunt newcomers).

Server (`server.js`): `TICK=1/20`, `SNAP_HZ=10`, `ROOM_CAP=40`, `MIN_POP=10` (bots top up to this),
`IDLE_MS=60000` (empty room closes).

Client (`client.js`): `SERVER_URL='wss://centi-server.fly.dev'`, default `userZoom=.95` (persisted in
localStorage as `centi.zoom`).

---

## Infrastructure status

| Thing | State |
|---|---|
| Domain centi.gg | Bought at Porkbun. 4 A records → GitHub Pages IPs, `www` CNAME → masterblasterzzz.github.io, Google TXT verification |
| HTTPS | Certificate finally issued after ~24 h (GitHub-side delay, not a config problem). Enforce HTTPS ticked |
| GitHub Pages | Deploys from `main` root. Custom domain set. Browser caches scripts ~10 min — **always Cmd+Shift+R after a push** |
| Fly.io | Deployed from `~/centi-game` on Craig's iMac via `fly deploy`. Machines auto-suspend when idle and wake on connect (first connect can take a few seconds). `curl https://centi-server.fly.dev/health` → `{"ok":true,"rooms":N,"players":N}` |
| Search Console | Domain property added and verified; sitemap submitted. Bing: import from GSC (may not be done yet) |
| PostHog | Events: `run_start` (mode solo/online), `run_end` (reason, killer, length, kills, seconds, portals), `kill`, `watch`, `share`, `online_failed`. Billing cap should be set to $0 (check) |
| Social card | og.png in repo. iMessage cached a broken preview from the cert-invalid period; test with `?v=N` |

**Redeploying the server** (after changes to `server.js` or `sim.js`):
```
cd ~/centi-game && git pull && fly deploy
```
The Docker image only copies `server.js` and `sim.js`.

**Craig's terminal setup:** flyctl installed at `~/.fly/bin`, PATH added to `~/.zshrc`, logged in as
transformer_film@xtra.co.nz.

---

## Open issues

1. **Visual artifacts** in some part of the globe — Craig saw them, no screenshot yet. Likely suspect:
   sinkhole shafts (drawn with `depthTest:false`) punching through when the horizon cull in `drawHoles`
   is off at certain camera angles. Need a screenshot + rough location (near pole / near a hole / ocean).
2. **Portal hold duration** — just deployed; untested by Craig. Should read as a beat at the mouth.
3. **Not yet tested with two real humans on the same globe.** This is the next thing to do.
4. **Mobile / cellular** online play untested.
5. **Fly machine wake-up** — first connect after idle can take several seconds; the 9 s timeout and
   "× Back to the menu" button cover it. To remove the delay: `min_machines_running = 1` in fly.toml
   (a few dollars/month). Do when there are testers.
6. **iMessage preview** shows favicon instead of og.png — probably cached from before HTTPS worked.

---

## Roadmap (agreed order)

1. **Get 5 real testers on centi.gg online.** Watch PostHog: survival times, return visits, `online_failed` reasons.
2. Fix whatever they hit. Balance from data, not guesses.
3. **Promotion:** clips (Craig's strength — cinematic mode `V` exists for this), small/mid gaming
   creators (10k–200k) with no ask, portal submissions (**CrazyGames, Poki** — they run ads and pay
   rev share, biggest revenue lever at this stage), one coordinated Reddit + Show HN burst.
4. **Revenue:** one rewarded video on the death screen ("watch to respawn at half length") — the only
   ad on centi.gg itself. No banners. Cosmetics (skins, trails, name colour) after multiplayer is proven;
   needs accounts + Stripe. Later: a supporter purchase that removes ads.
5. **Rocket with an advertising banner crossing the sky** — Craig's idea, agreed it's better than
   billboards on the terrain (off the playfield, charming even with no sponsor). Build after there are
   players; use it for self-promotion first.
6. Cloudflare in front of Pages when traffic warrants (DDoS + caching). Not needed for HTTPS any more.
7. Touch follow-finger steering (currently left/right halves).
8. Search Console / Bing check-in once indexed.

---

## Legal notes

- "Centipede" is an Atari trademark — never title it that. "centi" is fine.
- slither.io mechanics aren't copyrightable; don't use "slither" in marketing copy.
- Not affiliated with either; the About section says so.

---

## Session log (this stretch)

- Fixed menu camera spin (three attempts; final answer: fixed camera, no follow, live world behind)
- Domain, DNS, HTTPS, Search Console, sitemap, SEO/AEO metadata, JSON-LD (VideoGame + FAQ), llms.txt
- Split sim from render → `sim.js` + `client.js`; proved headless in Node
- Built and deployed the Fly.io server; client network layer; Play online button
- Fixed: stuck-on-Connecting (timeout + escape button), invisible own centipede (stale views),
  side-to-side wobble (render clock), zig-zag steering (client prediction), portal ping-pong
  (server-authoritative portal with hold), portal rings not cycling online
- Default zoom widened and persisted
