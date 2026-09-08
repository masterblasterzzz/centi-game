# Deploying the centi server to Fly.io

One small machine in Sydney runs the multiplayer world. The game itself stays on GitHub Pages.

## First time

```bash
# 1. install flyctl (macOS/Linux)
curl -L https://fly.io/install.sh | sh

# 2. from this repo folder
fly auth login
fly launch --no-deploy      # it reads fly.toml: app "centi-server", region syd
                            # say NO to Postgres, NO to Redis, NO to overwriting fly.toml
fly deploy
```

`fly deploy` prints the hostname, e.g. `centi-server.fly.dev`. If it differs from
`SERVER_URL` near the top of the script in index.html, update that one line.

## Checks

```bash
fly status                                   # is the machine up
fly logs                                     # live server log
curl https://centi-server.fly.dev/health     # {"ok":true,"rooms":1,"players":0}
```

## Later

```bash
fly deploy            # after any change to server.js or sim.js
fly scale count 2     # more machines if one gets busy
```

The machine suspends when nobody is playing and wakes on the next connection, so an
idle month costs very little. Watch the bill for the first fortnight.
