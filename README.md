# centi

A 3D globe centipede game in the spirit of the .io genre. Eat, grow, don't fall in.

Single file, no build step, no dependencies beyond three.js from a CDN. Open `index.html` in a browser or play the hosted build.

## Controls

| Input | Action |
|---|---|
| Mouse | Centipede follows the cursor. Hold the button to boost. |
| Keyboard | ← → or A/D to steer, space or shift to boost, C to switch camera, +/− to zoom |
| Touch | Left/right half of the screen to steer, two fingers to boost, pinch to zoom |
| Spectating | Drag to spin the globe |

## How it plays

- **Food** is scattered at random; eaten pellets respawn elsewhere after 9–18 s. White-blue **boost pellets** (ten on the globe) add a quarter of your current length.
- **Kill rule** is slither's: head into any body and you die, head-on kills both. The dead scatter **jelly** in their body colour, worth double a pellet.
- **Boost** costs length, so it's a spend, not a free speed-up.
- **Portals** sit on the poles. Enter an open one and you exit at the opposite pole. Each pole runs its own clock (green → amber at 5 s → red at 1 s → gone), and a body spans both poles mid-jump, so if *either* closes on you the far half is severed and becomes jelly.
- **Sinkholes** (ten, on staggered timers) grow in over 1.5 s, stay 14–28 s, then close and move. Inside the dust ring they pull you in; near the rim only boosting gets you out.
- **Storms** (two) wander at 1/8 centipede speed, avoiding the poles and each other. Their suction reaches ~3.6 funnel-radii out and beats normal speed close in.
- **Bots** come in three tiers. Easy ones wander and react late; medium ones feed properly and avoid well; hard ones hunt — when you're in range they aim for a point ahead of your head to cut you off, and boost when close.
- On death the world keeps running; you can **watch** your remains get eaten, follow any bot, or spin the globe freely.

## Design notes

**Movement on a sphere.** Never use latitude/longitude — the poles become singularities. The head is a unit vector `p` and a tangent heading `h`. Each frame `p` and `h` rotate about `p × h` to move, `h` rotates about `p` to steer, and both are re-orthonormalised to kill float drift. This is why the poles can host portals at all.

**Body.** A trail of head positions at fixed arc spacing (`SEG`). Segment *i* sits exactly `(i+1)·SEG` behind the head, interpolated between trail points, so it glides rather than snapping. A portal jump leaves a "cut" (two adjacent trail points far apart); the cut is what gets severed if a portal closes.

**Legs** are instanced cylinders, two per segment, swept fore-and-aft with a sine wave that travels down the body.

**Sinkhole depth.** The shaft is below the surface, so the globe would hide it. It's drawn with depth testing off, after the globe, and only while the hole faces the camera (dot with the camera direction must exceed `R / cameraDistance`, or it would show through from the far side).

**Sound** is fully synthesised with the Web Audio API — a 2/4 oompah tune and a 3/4 waltz on a rotating setlist, plus effects. No audio files.

## Tuning knobs (top of the script)

| Constant | What it does |
|---|---|
| `R` | Globe radius. Everything scales from here. |
| `SEG` | Body segment spacing; sets how many segments it takes to lap the globe. |
| `BASE_SPEED`, `TURN` | Turn radius ≈ `BASE_SPEED / TURN`. |
| `STEER_EASE` | Steering ramp; lower is more flowing, higher is snappier. |
| `HOLE_N`, `HOLE_R`, `HOLE_PULL_R`, `HOLE_PULL_MAX` | Sinkhole count, size, suction reach and strength. |
| `STORM_N`, `STORM_R`, `STORM_SPEED`, `PULL_R`, `PULL_MAX` | Same for storms. |
| `PORTAL_CYCLES` | Open/closed seconds and phase offset per pole. |
| `AI` | Look-ahead, reaction, hunt range and noise per bot tier. |

## Roadmap

1. Playtest with real people before adding anything. Watch where they die first.
2. First-minute grace: hard bots don't hunt below ~30 segments, hazards start further away.
3. Touch: follow-the-finger steering like the mouse.
4. Kill toasts, camera shake, high scores on device.
5. Split simulation from rendering, then an authoritative Node/WebSocket server (Colyseus) — one globe per room.
6. Cosmetics as the monetisation path; ads only on the death screen.

## Licence

All rights reserved for now. Not affiliated with slither.io or Atari's *Centipede*.
