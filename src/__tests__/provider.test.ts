import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type Game } from '@clutch/plugin-sdk';
import { describe, expect, it } from 'vitest';
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

function ctxWith(responses: Record<string, string | { status?: number; body: string }>, settings = {}) {
  return createTestContext({ pluginId: 'dev.chalifour.streameast', settings, responses });
}

describe('streameast provider', () => {
  it('resolves every free server of an ESPN-id match to an HLS candidate', async () => {
    const ctx = ctxWith(LIVE_RESPONSES);
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);

    expect(candidates.map((c) => c.label)).toEqual([
      'Streameast Server 1',
      'Streameast Server 2',
    ]);
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
    const ctx = ctxWith({ ...LIVE_RESPONSES, 'https://flyembed.click/embed/17.php': '<html></html>' });
    const candidates = await plugin.provider!.getStreams(twinsGiants, ctx);
    expect(candidates.map((c) => c.label)).toEqual(['Streameast Server 1']);
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
      Object.fromEntries(Object.entries(LIVE_RESPONSES).map(([k, v]) => [k.replace(MIRROR, other), v])),
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
