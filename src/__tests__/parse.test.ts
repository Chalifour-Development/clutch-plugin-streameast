import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeEvalBlobs,
  decryptXyzToken,
  findIframeSrc,
  findM3u8,
  parseMatches,
  parseSources,
  parseXyzEmbed,
} from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, '../__fixtures__', name), 'utf8');

describe('parseMatches', () => {
  const matches = parseMatches(fixture('home.html'));

  it('reads every match card with its ESPN id, teams, start time and link', () => {
    expect(matches.length).toBeGreaterThan(15);
    expect(matches).toContainEqual({
      espnEventId: '401886441',
      espnPath: 'hockey/nhl',
      startsAt: 1790204400,
      teams: ['Ottawa Senators', 'Toronto Maple Leafs'],
      path: '/nhl/ottawa-senators-vs-toronto-maple-leafs-2/',
      proOnly: false,
    });
  });

  it('flags premium-only matches', () => {
    expect(matches.find((m) => m.espnEventId === '401886429')?.proOnly).toBe(true);
  });

  it('skips cards without a match link', () => {
    expect(matches.every((m) => m.path.startsWith('/'))).toBe(true);
  });
});

describe('parseSources', () => {
  it('lists free sources and the active iframe', () => {
    const page = parseSources(fixture('game-server1.html'));
    expect(page.free).toEqual([
      { index: 1, name: 'Server 1', path: '/mlb/minnesota-twins-vs-san-francisco-giants-2/1' },
      { index: 2, name: 'Server 2', path: '/mlb/minnesota-twins-vs-san-francisco-giants-2/2' },
    ]);
    expect(page.activeIndex).toBe(1);
    expect(page.iframe).toBe('https://streame.center/stream-east/ch16.php');
  });

  it('reads the iframe of another source page', () => {
    const page = parseSources(fixture('game-server2.html'));
    expect(page.activeIndex).toBe(2);
    expect(page.iframe).toBe('https://flyembed.click/embed/17.php');
  });

  it('has no iframe before the stream opens or behind the paywall', () => {
    expect(parseSources(fixture('game-upcoming.html')).iframe).toBeUndefined();
    expect(parseSources(fixture('game-pro.html')).iframe).toBeUndefined();
  });
});

describe('embed helpers', () => {
  it('follows nested iframes, adding https to protocol-relative URLs', () => {
    expect(findIframeSrc(fixture('embed-streamecenter-ch.html'))).toBe(
      'https://streame.center/stream-east/hls.php?stream=16yuitzaerghbhc16',
    );
    expect(findIframeSrc(fixture('embed-flyembed.html'))).toBe(
      'https://exmxbxe.cfd/flyemb/c1szcbr3',
    );
  });

  it('finds a plain m3u8 literal and unescapes \\u0026', () => {
    expect(findM3u8(fixture('embed-streamecenter-hls.html'))).toMatch(
      /^https:\/\/edgestream\d\.pro\/hls\/16yuitzaerghbhc16\.m3u8\?st=[^&]+&e=\d+$/,
    );
  });

  it('decodes the XOR eval blob to reveal the signed URL', () => {
    const html = fixture('embed-exmxbxe.html');
    expect(findM3u8(html)).toBeUndefined();
    expect(findM3u8(decodeEvalBlobs(html).join('\n'))).toBe(
      'https://juxrd.hundxvision.co.uk/main/secure/98d795917a08a0cb3756370fc7e356535e6662662303443a28b0b455193ca88c/1790203165/mlb-giants.m3u8',
    );
  });
});

describe('xyzstreams embed', () => {
  it('reads the stream id, playlist hosts and token endpoints', () => {
    expect(parseXyzEmbed(fixture('embed-xyzstreams.html'), 'https://xyzstreams.st/embed?nfl6')).toEqual({
      streamId: 'nfl6',
      secret: 'MySuperSecretKey123!',
      servers: [
        { playlist: 'https://us2-hlss2.b-cdn.net/nfl6/mono.ts.m3u8', token: 'https://us2-hlss2.b-cdn.net/api/token' },
        { playlist: 'https://hlss2.b-cdn.net/nfl6/mono.ts.m3u8', token: 'https://hlss2.b-cdn.net/api/token' },
      ],
      serverParam: '2',
    });
  });

  it('reads the server parameter the player appends, which picks a live or a stale feed', () => {
    // server=1 began serving a day-old playlist whose segments 403 once the site moved to 2.
    const old = fixture('embed-xyzstreams.html').replace(/server=2/g, 'server=1');
    expect(parseXyzEmbed(old, 'https://xyzstreams.st/embed?nfl6')?.serverParam).toBe('1');
  });

  it('is not an xyzstreams page when the markers are missing', () => {
    expect(parseXyzEmbed(fixture('embed-flyembed.html'), 'https://flyembed.click/embed/17.php')).toBeUndefined();
  });

  it('decrypts the AES-CBC token with SHA-256 of the page secret', () => {
    const { iv, token } = JSON.parse(fixture('xyzstreams-token.json')) as { iv: string; token: string };
    expect(decryptXyzToken('MySuperSecretKey123!', iv, token)).toMatch(/^[0-9a-f]{32}$/);
  });
});
