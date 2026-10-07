# Streameast for Clutch

A [Clutch](https://github.com/Chalifour-Development/clutch-app) provider plugin that finds free
Streameast streams for the game you open.

## Install

In the app, open Settings, Plugins, and paste:

```
https://github.com/Chalifour-Development/clutch-plugin-streameast
```

## Settings

None. The plugin uses every Streameast mirror it knows (`src/mirrors.ts`), so there is no
mirror to configure. If every known mirror fails, it falls back to the mirrors listed at
https://v5.gostreameast.link/.

## How it works

1. It reads a mirror's homepage (cached for 5 minutes) and finds the match. Mirrors are tried in
   random order, and another mirror joins the race every 1.5 s or as soon as one fails, so a
   dead or rate-limited mirror costs at most 1.5 s. Streameast tags
   every match with its ESPN event id, which is the same id Clutch uses, so matches are exact
   (confidence 0.9). If there is no id, it matches on team names within 12 hours of kickoff.
2. It opens the match page and resolves every free server in parallel, each server page loaded
   from a different mirror so no single host's rate limit is hit. Premium servers are skipped.
   Once one server works, the others get 3 more seconds; the whole call stays under 12 s.
3. It follows each server's embed (nested iframes, the XOR `eval` obfuscation some embeds use,
   and xyzstreams' AES-encrypted tokens) to the signed `.m3u8`, and returns it as an HLS stream with the `User-Agent`, `Referer`
   and `Origin` headers the CDN checks.

Streams show up from one hour before start, when Streameast opens the player. Signed URLs expire
after a few hours, so they are resolved fresh each time you open a game.

## Verified

On 2026-10-04 the plugin was installed from this repo into the Clutch Android build on an Android
16 emulator. All three embed families played live video in ExoPlayer: streame.center
(NHL Jets @ Red Wings and NFL Cowboys @ Texans), xyzstreams, and flyembed (both on Cowboys @
Texans). Matches marked premium-only on Streameast have no free server, so the plugin returns no
streams for them.

On 2026-10-04 (evening) the NFL slate was rechecked live on the same emulator with v1.1.3. Lions
@ Panthers played through the Watch button (NBC SNF feed). Fixes from that run:

- 1.1.1: no streams for final, cancelled or postponed games. Streameast reuses a finished
  game's channel for the next match (a final Broncos @ 49ers served Chiefs @ Raiders).
- 1.1.2: name matching requires the same sport and both teams (Broncos once matched the NBA's
  Denver Nuggets).
- 1.1.3: each server's playlist is loaded before it is offered, capped at 5 s. When the
  edgestream CDN stopped answering, the app had been showing a black screen instead of failing
  over.

On 2026-10-04 (late evening) the live NHL games (Panthers @ Ducks, Flames @ Kraken, Golden Knights
@ Canucks) were checked with v1.1.5. None had a playable free server:

- Server 1 (streame.center / edgestream*.pro): the CDN accepts TCP but never finishes TLS from
  this network, on the Mac and the emulator alike.
- Server 2 (dlive.sx / dembed.top / cowedd4855ws.sbs): segments are gzipped MPEG-TS packed into
  PNG pixel data that only the site's JS unpacks. ExoPlayer fails with "Cannot find sync byte".
- 1.1.4: servers race a 12 s budget, so one slow embed no longer times out the whole call.
- 1.1.5: the plugin checks the first bytes of a segment and skips PNG-packed servers, so the app
  shows "No streams found" instead of a black screen.

On 2026-10-06 (v1.2.0) every live NHL game (7 of 9; the other two had not started) was checked
on the Android emulator. Fixes from that run:

- No more mirror setting: every mirror is used, and server pages are spread across them.
- xyzstreams switched its player to `server=2`. `server=1` still answered, but with a day-old
  playlist whose segments returned 403, so the plugin found nothing. It now reads the parameter
  from the player page.
- All free servers are resolved (it was the first 3, which were often all dead), and every
  playlist URL an embed lists is tried, not just the first.

## What it connects to

The Streameast mirrors (and, only if they all fail, the gostreameast.link directory), the embed
hosts that their pages point at, and their CDNs.
It sends no user data. The only cookie is `sso_checked=1`, which skips Streameast's login
redirect.

## Develop

This depends on `@clutch/plugin-sdk` and `@clutch/plugin-cli`, linked from a sibling checkout of
`clutch-app` at `../sports-streaming-app` until they are published to npm. Build them there first
with `pnpm build:packages`.

```bash
pnpm install
pnpm test           # unit tests against recorded pages in src/__fixtures__
pnpm build          # writes dist/plugin.js (committed; the app downloads it)
pnpm harness        # runs the bundle in QuickJS against fixtures/responses.json
pnpm harness:live   # the same against the real site; edit fixtures/mlb-game.json to a live game
```

Design notes: [docs/design.md](docs/design.md).
