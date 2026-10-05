import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type Game } from '@clutch/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from '../index';

const fixture = (name: string) => readFileSync(join(__dirname, '../__fixtures__', name), 'utf8');

const MIRROR = 'https://v2.streameast.ch';
const GAME_PATH = '/mlb/minnesota-twins-vs-san-francisco-giants-2/';
const FLY_PL =
  'https://exmxbxe.cfd/flyemb/pl/1790194185.fefbb3f9ace068591a541beafdeeec76f432299bf568ec9b161d7d15d584077f.mlb-giants';

const LIVE_RESPONSES = {
  [`${MIRROR}/`]: fixture('home.html'),
  [`${MIRROR}${GAME_PATH}`]: fixture('game-server1.html'),
  [`${MIRROR}${GAME_PATH}2`]: fixture('game-server2.html'),
  'https://streame.center/stream-east/ch16.php': fixture('embed-streamecenter-ch.html'),
  'https://streame.center/stream-east/hls.php?stream=16yuitzaerghbhc16': fixture(
    'embed-streamecenter-hls.html',
  ),
  'https://flyembed.click/embed/17.php': fixture('embed-flyembed.html'),
  // The host follows redirects and reports the final URL; model that here.
  'https://exmxbxe.cfd/flyemb/c1szcbr3': { body: fixture('embed-exmxbxe.html') },
};

function team(sport: string, name: string, shortName: string, abbreviation: string) {
  return { id: `${sport}:${abbreviation}`, sport, name, shortName, abbreviation, aliases: [] };
}

const twinsGiants: Game = {
  id: 'mlb:401817058',
  sport: 'mlb',
  title: 'Giants @ Twins',
  startsAt: new Date(1790192700 * 1000).toISOString(),
  status: 'live',
  competitors: [
    team('mlb', 'Minnesota Twins', 'Twins', 'MIN'),
    team('mlb', 'San Francisco Giants', 'Giants', 'SF'),
  ],
  keywords: ['MLB', 'baseball'],
};

const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:4\nseg.ts\n';
/** A real segment head: MPEG-TS behind a fake 42-byte WebP header, which ExoPlayer plays. */
const TS_HEAD = readFileSync(
  join(__dirname, '../__fixtures__', 'segment-head-webp-ts.bin'),
  'latin1',
);

/** Canned site responses; any .m3u8 the plugin probes answers as a live playlist. */
function ctxWith(
  responses: Record<string, string | { status?: number; body: string }>,
  settings = {},
) {
  const ctx = createTestContext({ pluginId: 'dev.chalifour.streameast', settings, responses });
  const canned = ctx.fetch;
  ctx.fetch = (async (url: string, init?: never) =>
    /\.m3u8(\?|$)/.test(url) && !(url in responses)
      ? createTestContext({ responses: { [url]: PLAYLIST } }).fetch(url)
      : /\/seg\.ts$/.test(url) && !(url in responses)
        ? createTestContext({ responses: { [url]: TS_HEAD } }).fetch(url)
        : canned(url, init)) as typeof ctx.fetch;
  return ctx;
}

describe('streameast provider', () => {
  it('resolves every free server of an ESPN-id match to an HLS candidate', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);

    expect(candidates.map((c) => c.label)).toEqual(['Streameast Server 1', 'Streameast Server 2']);
    const [s1, s2] = candidates;
    expect(s1).toMatchObject({
      kind: 'hls',
      confidence: 0.9,
      headers: { Referer: 'https://streame.center/', Origin: 'https://streame.center' },
    });
    expect(s1!.url).toMatch(/^https:\/\/edgestream\d\.pro\/hls\/16yuitzaerghbhc16\.m3u8\?st=/);
    expect(s2!.url).toBe(
      'https://juxrd.hundxvision.co.uk/main/secure/98d795917a08a0cb3756370fc7e356535e6662662303443a28b0b455193ca88c/1790203165/mlb-giants.m3u8',
    );
    expect(s2!.headers?.['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(s2!.headers?.Referer).toBe('https://exmxbxe.cfd/');

    const first = ctx.calls[0]!;
    expect(first.url).toBe(`${MIRROR}/`);
    expect(first.init?.headers?.Cookie).toBe('sso_checked=1');
  });

  it('falls back to team names when the game id is not an ESPN id', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const candidates = await plugin.provider!.getStreams({ ...twinsGiants, id: 'mlb:other' }, ctx);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.confidence).toBeGreaterThan(0.5);
    expect(candidates[0]!.confidence).toBeLessThan(0.9);
  });

  it('does not match a different game between the same teams days apart', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const later = new Date(1790192700 * 1000 + 3 * 86_400_000).toISOString();
    const candidates = await plugin.provider!.getStreams(
      { ...twinsGiants, id: 'mlb:other', startsAt: later },
      ctx,
    );
    expect(candidates).toEqual([]);
  });

  it('returns nothing for a game streameast does not list', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const game: Game = {
      ...twinsGiants,
      id: 'nfl:1',
      sport: 'nfl',
      competitors: [
        team('nfl', 'Green Bay Packers', 'Packers', 'GB'),
        team('nfl', 'Chicago Bears', 'Bears', 'CHI'),
      ],
    };
    expect(await plugin.provider!.getStreams(game, ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(1);
  });

  it('returns nothing before the player opens', async () => {
    const ctx = ctxWith({
      [`${MIRROR}/`]: fixture('home.html'),
      [`${MIRROR}/nhl/ottawa-senators-vs-toronto-maple-leafs-2/`]: fixture('game-upcoming.html'),
    });
    const game: Game = {
      ...twinsGiants,
      id: 'nhl:401886441',
      sport: 'nhl',
      startsAt: new Date(1790204400 * 1000).toISOString(),
      competitors: [],
    };
    expect(await plugin.provider!.getStreams(game, ctx)).toEqual([]);
  });

  it('skips a server whose embed cannot be read and keeps the others', async () => {
    const ctx = ctxWith({
      ...LIVE_RESPONSES,
      'https://flyembed.click/embed/17.php': '<html></html>',
    });
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);
    expect(candidates.map((c) => c.label)).toEqual(['Streameast Server 1']);
  });

  it('never name-matches a game from another sport that shares a city', async () => {
    // Seen live: Broncos @ 49ers (nfl) dropped off the list and "Denver" matched the NBA's
    // Utah Jazz vs Denver Nuggets, so the app offered a basketball game.
    const home = `<div class="m-card" data-espn-event-id="401914127" data-espn-path="basketball/nba" data-time="1790192700" data-team-names="Utah Jazz|Denver Nuggets"><a class="m-card__link" href="/nba/utah-jazz-vs-denver-nuggets-2/"></a></div>`;
    const ctx = ctxWith({
      ...LIVE_RESPONSES,
      [`${MIRROR}/`]: home,
      [`${MIRROR}/nba/utah-jazz-vs-denver-nuggets-2/`]: fixture('game-server1.html'),
    });
    const broncos: Game = {
      ...twinsGiants,
      id: 'nfl:401872975',
      sport: 'nfl',
      title: 'Broncos @ 49ers',
      startsAt: new Date((1790192700 - 3600) * 1000).toISOString(),
      competitors: [
        { ...team('nfl', 'Denver Broncos', 'Broncos', 'DEN'), aliases: ['Denver'] },
        { ...team('nfl', 'San Francisco 49ers', '49ers', 'SF'), aliases: ['San Francisco'] },
      ],
    };
    expect(await plugin.provider!.getStreams(broncos, ctx)).toEqual([]);
  });

  it('does not name-match on one team alone', async () => {
    const home = `<div class="m-card" data-espn-path="baseball/mlb" data-time="1790192700" data-team-names="Minnesota Twins|Chicago Cubs"><a class="m-card__link" href="/mlb/twins-cubs/"></a></div>`;
    const ctx = ctxWith({
      ...LIVE_RESPONSES,
      [`${MIRROR}/`]: home,
      [`${MIRROR}/mlb/twins-cubs/`]: fixture('game-server1.html'),
    });
    expect(await plugin.provider!.getStreams({ ...twinsGiants, id: 'mlb:other' }, ctx)).toEqual([]);
  });

  it.each(['final', 'cancelled', 'postponed'] as const)(
    'returns nothing for a %s game, whose channel streameast reuses for another match',
    async (status) => {
      const ctx = ctxWith(LIVE_RESPONSES);
      expect(await plugin.provider!.getStreams({ ...twinsGiants, status }, ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    },
  );

  it('drops a server whose playlist cannot be loaded, so the app never opens a dead stream', async () => {
    // Seen live: Server 1's CDN (edgestream*.pro) stopped answering from the device, and the
    // player sat on a black screen because a hung connection never raises an error.
    const ctx = ctxWith(LIVE_RESPONSES);
    const inner = ctx.fetch;
    ctx.fetch = (async (url: string, init?: never) => {
      if (url.includes('edgestream')) throw new Error('timeout');
      return inner(url, init);
    }) as typeof ctx.fetch;
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);
    expect(candidates.map((c) => c.label)).toEqual(['Streameast Server 2']);
  });

  it('gives up on a playlist that hangs instead of stalling every server', async () => {
    vi.useFakeTimers();
    try {
      const ctx = ctxWith(LIVE_RESPONSES);
      const inner = ctx.fetch;
      ctx.fetch = ((url: string, init?: never) =>
        url.includes('edgestream') && url.includes('.m3u8')
          ? new Promise(() => {})
          : inner(url, init)) as typeof ctx.fetch;
      const pending = plugin.provider!.getStreams(twinsGiants, ctx);
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await pending).map((c) => c.label)).toEqual(['Streameast Server 2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the servers that resolved before the deadline instead of timing out entirely', async () => {
    // Seen on the emulator: a slow embed chain pushed getStreams past the app's 15 s limit, so
    // the app showed "No streams found" even though one server had already resolved.
    vi.useFakeTimers();
    try {
      const ctx = ctxWith(LIVE_RESPONSES);
      const inner = ctx.fetch;
      ctx.fetch = ((url: string, init?: never) =>
        url.startsWith('https://flyembed.click/')
          ? new Promise(() => {})
          : inner(url, init)) as typeof ctx.fetch;
      const pending = plugin.provider!.getStreams(twinsGiants, ctx);
      await vi.advanceTimersByTimeAsync(12_500);
      expect((await pending).map((c) => c.label)).toEqual(['Streameast Server 1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a server whose segments are not MPEG-TS, such as video packed into PNG pixels', async () => {
    // Seen live on NHL games: dlive.sx/dembed.top hides gzipped TS inside PNG pixel data and
    // unpacks it in browser JS. ExoPlayer fails with "Cannot find sync byte" on a black screen.
    const png = readFileSync(
      join(__dirname, '../__fixtures__', 'segment-head-png-pixels.bin'),
      'latin1',
    );
    const ctx = ctxWith(LIVE_RESPONSES);
    const inner = ctx.fetch;
    ctx.fetch = ((url: string, init?: never) =>
      url.includes('edgestream') && !url.includes('.m3u8')
        ? createTestContext({ responses: { [url]: png } }).fetch(url)
        : inner(url, init)) as typeof ctx.fetch;
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);
    expect(candidates.map((c) => c.label)).toEqual(['Streameast Server 2']);
  });

  it('drops a server whose playlist is not HLS', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    ctx.fetch = (async (url: string, init?: never) => {
      if (url.includes('.m3u8'))
        return createTestContext({
          responses: { [url]: { status: 403, body: 'Forbidden' } },
        }).fetch(url);
      return createTestContext({ responses: LIVE_RESPONSES }).fetch(url, init);
    }) as typeof ctx.fetch;
    expect(await plugin.provider!.getStreams(twinsGiants, ctx)).toEqual([]);
  });

  it('caches the match list between games', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    await plugin.provider!.getStreams(twinsGiants, ctx);
    const before = ctx.calls.filter((c) => c.url === `${MIRROR}/`).length;
    await plugin.provider!.getStreams(twinsGiants, ctx);
    expect(ctx.calls.filter((c) => c.url === `${MIRROR}/`).length).toBe(before);
  });

  it('uses the configured mirror, tolerating a trailing slash', async () => {
    const other = 'https://v2.thestreameast.su';
    const ctx = ctxWith(
      Object.fromEntries(
        Object.entries(LIVE_RESPONSES).map(([k, v]) => [k.replace(MIRROR, other), v]),
      ),
      { mirrorUrl: `${other}/` },
    );
    expect(await plugin.provider!.getStreams(twinsGiants, ctx)).toHaveLength(2);
  });

  it('throws a clear error when the mirror is rate limiting or down', async () => {
    const ctx = ctxWith({ [`${MIRROR}/`]: { status: 429, body: 'error code: 1015' } });
    await expect(plugin.provider!.getStreams(twinsGiants, ctx)).rejects.toThrow(/429.*mirror/i);
  });

  it('lists live and upcoming matches as channels for Test connection', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const channels = await plugin.provider!.getChannels!(ctx);
    expect(channels.length).toBeGreaterThan(15);
    expect(channels[0]).toMatchObject({ name: expect.stringContaining(' vs ') });
  });
});

describe('xyzstreams servers', () => {
  const NFL = '/nfl/los-angeles-rams-vs-philadelphia-eagles/';
  const ramsEagles: Game = {
    ...twinsGiants,
    id: 'nfl:401872970',
    sport: 'nfl',
    title: 'Eagles @ Rams',
    competitors: [],
  };

  it('decrypts the token from the first working host into a tokenized playlist URL', async () => {
    const ctx = ctxWith({
      [`${MIRROR}/`]: fixture('home-nfl.html'),
      // Serve the server-2 page as the landing page so it is the active source.
      [`${MIRROR}${NFL}`]: fixture('game-nfl-server2.html'),
      'https://xyzstreams.st/embed?nfl6': fixture('embed-xyzstreams.html'),
      'https://us2-hlss2.b-cdn.net/api/token': { status: 503, body: 'down' },
      'https://hlss2.b-cdn.net/api/token': fixture('xyzstreams-token.json'),
    });
    const candidates = await plugin.provider!.getStreams(ramsEagles, ctx);
    const xyz = candidates.find((c) => c.label === 'Streameast Server 2');
    expect(xyz?.url).toMatch(
      /^https:\/\/hlss2\.b-cdn\.net\/nfl6\/mono\.ts\.m3u8\?token=[0-9a-f]{32}&server=1$/,
    );
    expect(xyz?.headers?.Referer).toBe('https://xyzstreams.st/');
  });
});
