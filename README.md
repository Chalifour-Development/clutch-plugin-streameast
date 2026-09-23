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
3. It follows each server's embed (nested iframes, plus the XOR `eval` obfuscation some embeds
   use) to the signed `.m3u8`, and returns it as an HLS stream with the `User-Agent`, `Referer`
   and `Origin` headers the CDN checks.

Streams show up from one hour before start, when Streameast opens the player. Signed URLs expire
after a few hours, so they are resolved fresh each time you open a game.

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
