# Streameast for Clutch

A [Clutch](https://github.com/Chalifour-Development/clutch-app) provider plugin that finds free
Streameast streams for the game you open.

## Install

In the app, open Settings, Plugins, and paste:

```
https://github.com/Chalifour-Development/clutch-plugin-streameast
```

## Settings

| Setting    | Default                    | Notes                                                      |
| ---------- | -------------------------- | ---------------------------------------------------------- |
| Mirror URL | `https://v2.streameast.ch` | Change it if the mirror goes down or starts answering 429. |

Current mirrors are listed at https://v5.gostreameast.link/.

## How it works

1. It reads the mirror's homepage (cached for 5 minutes) and finds the match. Streameast tags
   every match with its ESPN event id, which is the same id Clutch uses, so matches are exact
   (confidence 0.9). If there is no id, it matches on team names within 12 hours of kickoff.
2. It opens the match page and resolves up to 3 free servers in parallel. Premium servers are
   skipped.
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

## What it connects to

Only the mirror you configure, the embed hosts that the mirror's pages point at, and their CDNs.
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
