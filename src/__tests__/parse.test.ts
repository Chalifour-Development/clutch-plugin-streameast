import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEvalBlobs, findIframeSrc, findM3u8, parseMatches, parseSources } from '../parse';

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
