# Streameast provider: design

Linear: LAB-62. A Clutch provider plugin that finds free Streameast streams for a game.

## What the site looks like (recorded 2026-09-23)

- Mirrors (`www.streameast.ch`, `.sk`, `thestreameast.su`, ...) redirect to a `v2.` host.
  A request without the cookie `sso_checked=1` is bounced through `connect.php` and rate
  limited (HTTP 429, Cloudflare 1015). With the cookie, plain HTTP gets the real page.
- The homepage lists every match as a `div.m-card` with data attributes:
  `data-espn-event-id`, `data-espn-path` (`hockey/nhl`), `data-time` (unix start),
  `data-team-names` (`Home|Away`), `data-pro-only`, plus an `a.m-card__link` href.
- A match page (`/nhl/<slug>/`) shows a countdown until one hour before start. After that
  it lists sources as `a.stream-alt-item` (`/<slug>/1`, `/2`, ...). Items with class
  `stream-alt-item-pro` are premium and show a paywall. The active source is an
  `<iframe id="iframe" src=...>`.
- Embeds seen:
  - `streame.center/stream-east/chN.php` -> iframe `hls.php?stream=...` -> a JS literal
    `streamUrl = "https://edgestreamN.pro/hls/<id>.m3u8?st=...&e=..."`. It needs a
    `streame.center` Referer. (The CDN was unreachable from the dev network.)
  - `flyembed.click/embed/N.php` -> iframe `exmxbxe.cfd/flyemb/<id>` -> 302 -> a page with
    the JW Player config hidden in a XOR-encoded byte array evaluated with `eval`. Decoded,
    it holds `SIGNED_URL = "https://.../mlb-giants.m3u8"`. The playlist needs a browser
    User-Agent. Segments are MPEG-TS behind a 42-byte fake WebP header (verified 720p
    H.264 + AAC).

## Flow

1. **Match list.** GET a mirror homepage, parse the `m-card`s, and cache the result in
   `ctx.storage` for 5 minutes. Mirrors (`KNOWN_MIRRORS` in `src/mirrors.ts`) are raced in
   random order with a 1.5 s stagger; a mirror that errors, answers non-2xx, or lists no
   matches makes the next one start at once. If all fail, mirrors from the
   gostreameast.link directory (cached a day) are tried the same way.
2. **Pick the match.** Clutch game ids are `<sport>:<espnEventId>`, so the first choice is an
   exact `data-espn-event-id` match (confidence 0.9). Otherwise, run `matchGameToChannels`
   on the team names, only among matches starting within 12 hours of `game.startsAt`.
3. **Sources.** GET the match page (first mirror whose copy has a player), keep every
   non-premium `stream-alt-item`, and read each one's `iframe#iframe` src. The active source
   reuses the page already fetched; each other server's page starts on a different mirror.
4. **Resolve the embed.** Resolution is generic and works on any embed, stopping after 4
   iframe hops:
   - an `https://...m3u8` literal in the HTML means we are done;
   - otherwise, decode any XOR/char-code `eval` blob and look again;
   - otherwise, follow the first nested `<iframe src>` with the current page as Referer.
   - `xyzstreams.st/embed?<id>`: the page AES-encrypts a token per HLS host. It fetches
     `<host>/api/token` (`{iv, token}` in hex), decrypts with AES-256-CBC using
     SHA-256(`SECRET_KEY` from the page), and appends `?token=<t>&server=<n>` to
     `<host>/<id>/mono.ts.m3u8`, where `<n>` is read from the page (now `2`; `1` serves a
     stale playlist). Only https hosts are used; the cleartext duckdns host is
     skipped because Android blocks cleartext playback. Crypto is @noble (pure JS) because
     QuickJS has no WebCrypto, TextEncoder or TextDecoder.
5. **Candidate.** `kind: 'hls'` with `User-Agent`, `Referer` and `Origin` set to the page
   that held the URL. Confidence comes from step 2. Signed URLs expire in a few hours, so
   they are resolved each time a game is opened, never cached.

Returning `[]` is the normal answer for: no match, not live yet, premium only, or an embed
we cannot read. We throw only if every mirror fails.

## Settings

None. Mirrors are built in and all used.

## Risks

- The fake-WebP segment wrapper plays in ffmpeg. It is unverified on AVPlayer and ExoPlayer.
- Markup and embed obfuscation change often. Fixtures are real recordings, so a breakage
  shows up as a failing parser test once the fixtures are refreshed.
