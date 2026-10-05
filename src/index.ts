import {
  definePlugin,
  matchGameToChannels,
  type Channel,
  type Game,
  type PluginContext,
  type StreamCandidate,
} from '@clutch/plugin-sdk';
import {
  decodeEvalBlobs,
  decryptXyzToken,
  findIframeSrc,
  findM3u8,
  parseMatches,
  parseSources,
  parseXyzEmbed,
  type Match,
  type XyzEmbed,
} from './parse';

const DEFAULT_MIRROR = 'https://v2.streameast.ch';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** Skips the SSO bounce through connect.php, which is rate limited. */
const SITE_HEADERS = { 'User-Agent': UA, Cookie: 'sso_checked=1' };
const CACHE_KEY = 'matches';
const CACHE_TTL_MS = 5 * 60_000;
const MAX_SERVERS = 3;
const MAX_EMBED_HOPS = 4;
const MATCH_WINDOW_MS = 12 * 3_600_000;
const ESPN_ID_CONFIDENCE = 0.9;
const PROBE_TIMEOUT_MS = 5_000;

function mirrorOf(ctx: PluginContext): string {
  const raw = ctx.settings.mirrorUrl;
  const url = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_MIRROR;
  return url.replace(/\/+$/, '');
}

function originOf(url: string): string {
  return /^https?:\/\/[^/]+/.exec(url)?.[0] ?? url;
}

async function loadMatches(ctx: PluginContext, mirror: string): Promise<Match[]> {
  const raw = await ctx.storage.get(CACHE_KEY);
  if (raw) {
    try {
      const cached = JSON.parse(raw) as { mirror: string; fetchedAt: number; matches: Match[] };
      if (cached.mirror === mirror && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.matches;
      }
    } catch {
      // Corrupt cache: refetch below.
    }
  }
  const response = await ctx.fetch(`${mirror}/`, { headers: SITE_HEADERS });
  if (!response.ok) {
    throw new Error(
      `Streameast mirror ${mirror} answered ${response.status}. It may be rate limiting or down; try another mirror in Settings, Providers.`,
    );
  }
  const matches = parseMatches(await response.text());
  if (matches.length === 0) {
    ctx.log.warn('No matches found on', mirror, '- the page layout may have changed.');
  }
  await ctx.storage.set(CACHE_KEY, JSON.stringify({ mirror, fetchedAt: Date.now(), matches }));
  return matches;
}

function titleOf(m: Match): string {
  return m.teams.length ? m.teams.join(' vs ') : m.path;
}

/**
 * Whether a card can be this game's sport. Cards say `football/nfl`, `hockey/nhl`; Clutch
 * sport ids are the league (`nfl`, `nhl`, `f1`). Cards without a path stay eligible.
 */
function sameSport(sport: string, m: Match): boolean {
  if (!m.espnPath) return true;
  const league = m.espnPath.split('/').pop()!.toLowerCase();
  return league === sport.toLowerCase();
}

/** Best match for the game and how sure we are. */
function pickMatch(game: Game, matches: Match[]): { match: Match; confidence: number } | undefined {
  // Clutch's ESPN-backed sports use `<sport>:<espnEventId>` ids, and every card carries one.
  const espnId = game.id.split(':')[1];
  const exact = matches.find((m) => m.espnEventId !== undefined && m.espnEventId === espnId);
  if (exact) return { match: exact, confidence: ESPN_ID_CONFIDENCE };

  const start = Date.parse(game.startsAt);
  const nearby = matches.filter(
    (m) =>
      sameSport(game.sport, m) &&
      (Number.isNaN(start) || Math.abs(m.startsAt * 1000 - start) <= MATCH_WINDOW_MS),
  );
  const channels: Channel[] = nearby.map((m) => ({ id: m.path, name: titleOf(m) }));
  // A one-team hit is how a finished Broncos @ 49ers matched the NBA's Denver Nuggets: a match
  // listing is two named teams, so anything short of both is a different game.
  const best = matchGameToChannels(game, channels).find((m) => m.reasons.includes('both-teams'));
  if (!best) return undefined;
  const match = nearby.find((m) => m.path === best.channel.id);
  if (!match) return undefined;
  // Capped below the exact-id confidence: a name match is a weaker signal.
  return { match, confidence: Math.min(best.confidence, ESPN_ID_CONFIDENCE - 0.1) };
}

/**
 * Whether the playlist answers as HLS with the headers the player will send. Streameast's CDNs
 * come and go per network (edgestream*.pro stopped answering mid-game), and a player handed a
 * URL that never connects shows a black screen instead of failing over, so dead servers must
 * never reach the app. Bounded by the host's fetch timeout and run in parallel per server.
 */
async function playlistLoads(
  ctx: PluginContext,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const probe = (async () => {
    try {
      const r = await ctx.fetch(url, { headers });
      return r.ok && (await r.text()).trimStart().startsWith('#EXTM3U');
    } catch {
      return false;
    }
  })();
  // The host fetch has no timeout and a dead CDN hangs rather than refusing; cap it so one
  // dead server cannot push the whole call past the app's provider deadline.
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS));
  return Promise.race([probe, timeout]);
}

/** First xyzstreams host whose token endpoint answers; the token rides as `?token=`. */
async function resolveXyz(
  ctx: PluginContext,
  xyz: XyzEmbed,
  page: string,
): Promise<{ url: string; page: string } | undefined> {
  for (const server of xyz.servers) {
    try {
      const r = await ctx.fetch(server.token, { headers: { 'User-Agent': UA, Referer: page } });
      if (!r.ok) continue;
      const data = (await r.json()) as { iv?: unknown; token?: unknown };
      if (typeof data.iv !== 'string' || typeof data.token !== 'string') continue;
      const token = decryptXyzToken(xyz.secret, data.iv, data.token);
      if (!token) continue;
      return { url: `${server.playlist}?token=${encodeURIComponent(token)}&server=1`, page };
    } catch (error) {
      ctx.log.debug('xyzstreams token failed', server.token, String(error));
    }
  }
  return undefined;
}

/** Follow an embed through nested iframes and obfuscation to a playable HLS URL. */
async function resolveEmbed(
  ctx: PluginContext,
  embedUrl: string,
  referer: string,
): Promise<{ url: string; page: string } | undefined> {
  let url = embedUrl;
  let ref = referer;
  for (let hop = 0; hop < MAX_EMBED_HOPS; hop++) {
    const response = await ctx.fetch(url, { headers: { 'User-Agent': UA, Referer: ref } });
    if (!response.ok) {
      ctx.log.debug('Embed', url, 'answered', response.status);
      return undefined;
    }
    const page = response.url || url;
    const html = await response.text();
    const xyz = parseXyzEmbed(html, page);
    if (xyz) return resolveXyz(ctx, xyz, page);
    const direct = findM3u8(html) ?? decodeEvalBlobs(html).map(findM3u8).find(Boolean);
    if (direct) return { url: direct, page };
    const next = findIframeSrc(html, page);
    if (!next) return undefined;
    ref = page;
    url = next;
  }
  return undefined;
}

export default definePlugin({
  provider: {
    async getStreams(game, ctx): Promise<StreamCandidate[]> {
      // Streameast keeps listing a game after it ends while reusing its channel for the next
      // match (seen: a final Broncos @ 49ers page streaming Chiefs @ Raiders). It is live-only,
      // so an ended or called-off game can only ever yield the wrong broadcast.
      if (game.status === 'final' || game.status === 'cancelled' || game.status === 'postponed') {
        return [];
      }
      const mirror = mirrorOf(ctx);
      const picked = pickMatch(game, await loadMatches(ctx, mirror));
      if (!picked) return [];
      const { match, confidence } = picked;

      const matchUrl = mirror + match.path;
      const first = await ctx.fetch(matchUrl, { headers: SITE_HEADERS });
      if (!first.ok) {
        ctx.log.warn('Match page answered', first.status, matchUrl);
        return [];
      }
      const page = parseSources(await first.text());
      if (!page.iframe) {
        ctx.log.info('No player yet for', titleOf(match), '(not live, or premium only).');
        return [];
      }

      const servers = page.free.length
        ? page.free.slice(0, MAX_SERVERS)
        : [{ index: 1, name: 'Server 1', path: match.path }];
      // Servers are independent: resolve them in parallel to stay inside the 15 s budget.
      const results = await Promise.all(
        servers.map(async (server): Promise<StreamCandidate | undefined> => {
          try {
            let iframe = page.iframe;
            if (page.free.length && server.index !== (page.activeIndex ?? 1)) {
              const r = await ctx.fetch(mirror + server.path, { headers: SITE_HEADERS });
              iframe = r.ok ? parseSources(await r.text()).iframe : undefined;
            }
            if (!iframe) return undefined;
            const resolved = await resolveEmbed(ctx, iframe, `${mirror}/`);
            if (!resolved) {
              ctx.log.info('Could not read', server.name, 'embed', iframe);
              return undefined;
            }
            const origin = originOf(resolved.page);
            const headers = { 'User-Agent': UA, Referer: `${origin}/`, Origin: origin };
            if (!(await playlistLoads(ctx, resolved.url, headers))) {
              ctx.log.info(server.name, 'playlist did not load; skipping', resolved.url);
              return undefined;
            }
            return {
              url: resolved.url,
              kind: 'hls',
              label: `Streameast ${server.name}`,
              providerId: ctx.pluginId,
              confidence,
              headers,
              meta: { match: match.path, server: server.index },
            };
          } catch (error) {
            ctx.log.warn(server.name, 'failed:', String(error));
            return undefined;
          }
        }),
      );
      return results.filter((c): c is StreamCandidate => c !== undefined);
    },

    async getChannels(ctx): Promise<Channel[]> {
      const matches = await loadMatches(ctx, mirrorOf(ctx));
      return matches.map((m) => ({
        id: m.path,
        name: titleOf(m),
        ...(m.espnPath ? { group: m.espnPath.split('/').pop()!.toUpperCase() } : {}),
      }));
    },
  },
});
