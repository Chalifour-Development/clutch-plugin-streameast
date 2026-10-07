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
  findAllM3u8,
  findIframeSrc,
  parseMatches,
  parseMirrorDirectory,
  parseSources,
  parseXyzEmbed,
  type Match,
  type XyzEmbed,
} from './parse';
import { KNOWN_MIRRORS } from './mirrors';

const MIRROR_DIRECTORY = 'https://v5.gostreameast.link/';
const MIRRORS_KEY = 'mirrors';
const MIRRORS_TTL_MS = 24 * 3_600_000;
/** The directory is a nice-to-have; it must not eat into the streams budget. */
const DIRECTORY_TIMEOUT_MS = 2_000;
/** How long one mirror gets before the next one is tried alongside it. */
const MIRROR_STAGGER_MS = 1_500;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** Skips the SSO bounce through connect.php, which is rate limited. */
const SITE_HEADERS = { 'User-Agent': UA, Cookie: 'sso_checked=1' };
const CACHE_KEY = 'matches';
const CACHE_TTL_MS = 5 * 60_000;
const MAX_EMBED_HOPS = 4;
const MATCH_WINDOW_MS = 12 * 3_600_000;
const ESPN_ID_CONFIDENCE = 0.9;
const PROBE_TIMEOUT_MS = 5_000;
/** Below the app's 15 s provider timeout, leaving room for the sandbox round trip. */
const STREAMS_BUDGET_MS = 12_000;
/** How long the other servers get once one has resolved. */
const GRACE_AFTER_FIRST_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originOf(url: string): string {
  return /^https?:\/\/[^/]+/.exec(url)?.[0] ?? url;
}

async function readCache<T>(ctx: PluginContext, key: string, ttlMs: number): Promise<T | undefined> {
  const raw = await ctx.storage.get(key);
  if (!raw) return undefined;
  try {
    const cached = JSON.parse(raw) as { fetchedAt: number; value: T };
    return Date.now() - cached.fetchedAt < ttlMs ? cached.value : undefined;
  } catch {
    return undefined; // Corrupt cache: refetch.
  }
}

async function writeCache(ctx: PluginContext, key: string, value: unknown): Promise<void> {
  await ctx.storage.set(key, JSON.stringify({ fetchedAt: Date.now(), value }));
}

/** Fisher-Yates, so load spreads over the mirrors instead of always hitting the first. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Every known mirror, in random order so load spreads instead of always hitting the first. */
function knownMirrors(): string[] {
  return shuffled(KNOWN_MIRRORS);
}

/**
 * Mirrors on the directory that are not already known, for when every known mirror failed.
 * The directory's `www.` links redirect to `v2.` hosts, so both spellings name one mirror.
 * Cached for a day, an empty answer included, so a dead directory costs one try a day.
 */
async function directoryMirrors(ctx: PluginContext): Promise<string[]> {
  let listed = await readCache<string[]>(ctx, MIRRORS_KEY, MIRRORS_TTL_MS);
  if (!listed) {
    listed = [];
    try {
      const r = await Promise.race([
        ctx.fetch(MIRROR_DIRECTORY, { headers: { 'User-Agent': UA } }),
        sleep(DIRECTORY_TIMEOUT_MS).then(() => undefined),
      ]);
      if (r?.ok) listed = parseMirrorDirectory(await r.text());
    } catch (error) {
      ctx.log.debug('Mirror directory failed', String(error));
    }
    await writeCache(ctx, MIRRORS_KEY, listed);
  }
  const known = new Set(KNOWN_MIRRORS.map((m) => m.replace('://v2.', '://')));
  return shuffled(listed.filter((m) => !known.has(m.replace('://www.', '://'))));
}

/**
 * Run `attempt` against each mirror until one returns a value. A new mirror joins every
 * MIRROR_STAGGER_MS (or as soon as one fails), so a hanging mirror costs 1.5 s, not the budget.
 */
function firstMirror<T>(
  mirrors: readonly string[],
  attempt: (mirror: string) => Promise<T | undefined>,
): Promise<{ mirror: string; value: T } | undefined> {
  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let done = false;
    const launch = (): void => {
      if (done || next >= mirrors.length) {
        if (!done && running === 0) {
          done = true;
          resolve(undefined);
        }
        return;
      }
      const mirror = mirrors[next++]!;
      running++;
      let settled = false;
      const settle = (value: T | undefined): void => {
        if (settled) return;
        settled = true;
        running--;
        if (done) return;
        if (value !== undefined) {
          done = true;
          resolve({ mirror, value });
        } else {
          launch();
        }
      };
      attempt(mirror).then(settle, () => settle(undefined));
      void sleep(MIRROR_STAGGER_MS).then(() => {
        if (!settled) launch();
      });
    };
    launch();
  });
}

/** GET a page from the first mirror that serves one `accept` likes; returns its origin too. */
async function fetchFromMirrors<T>(
  ctx: PluginContext,
  mirrors: readonly string[],
  path: string,
  accept: (html: string) => T | undefined,
): Promise<{ mirror: string; value: T } | undefined> {
  return firstMirror(mirrors, async (mirror) => {
    const r = await ctx.fetch(mirror + path, { headers: SITE_HEADERS });
    if (!r.ok) {
      ctx.log.debug('Mirror', mirror, 'answered', r.status, 'for', path);
      return undefined;
    }
    return accept(await r.text());
  });
}

async function loadMatches(ctx: PluginContext): Promise<Match[]> {
  const cached = await readCache<Match[]>(ctx, CACHE_KEY, CACHE_TTL_MS);
  if (cached) return cached;
  const listing = (html: string) => {
    const matches = parseMatches(html);
    return matches.length ? matches : undefined;
  };
  const hit =
    (await fetchFromMirrors(ctx, knownMirrors(), '/', listing)) ??
    (await fetchFromMirrors(ctx, await directoryMirrors(ctx), '/', listing));
  if (!hit) {
    throw new Error(
      'No Streameast mirror listed any matches. They may all be down or rate limiting.',
    );
  }
  await writeCache(ctx, CACHE_KEY, hit.value);
  return hit.value;
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
  const channels: Channel[] = nearby.map((m) => ({
    id: m.path,
    name: titleOf(m),
  }));
  // A one-team hit is how a finished Broncos @ 49ers matched the NBA's Denver Nuggets: a match
  // listing is two named teams, so anything short of both is a different game.
  const best = matchGameToChannels(game, channels).find((m) => m.reasons.includes('both-teams'));
  if (!best) return undefined;
  const match = nearby.find((m) => m.path === best.channel.id);
  if (!match) return undefined;
  // Capped below the exact-id confidence: a name match is a weaker signal.
  return {
    match,
    confidence: Math.min(best.confidence, ESPN_ID_CONFIDENCE - 0.1),
  };
}

/** Resolve a playlist entry against the playlist URL (QuickJS has no URL class). */
function resolveUrl(base: string, ref: string): string {
  if (/^https?:\/\//.test(ref)) return ref;
  if (ref.startsWith('//')) return `https:${ref}`;
  if (ref.startsWith('/')) return originOf(base) + ref;
  return base.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + ref;
}

/**
 * Whether a segment's first bytes are something ExoPlayer plays. Seen: raw MPEG-TS, and TS behind
 * a fake 42-byte WebP header (both play), versus gzipped TS packed into PNG pixels that only
 * the site's own JS can unpack (ExoPlayer: "Cannot find sync byte"). Bodies cross the bridge
 * as text, so binary is mangled: match the leading signature, which survives decoding, rather
 * than TS packet spacing, which does not.
 */
function segmentPlayable(head: string): boolean {
  const start = head.slice(0, 8);
  if (/^.?PNG/.test(start)) return false;
  if (/^\s*</.test(start)) return false;
  return head.length > 0;
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
      const playlist = r.ok ? await r.text() : '';
      if (!playlist.trimStart().startsWith('#EXTM3U')) return false;
      // A master playlist lists variants, not segments; the variants share a CDN, so accept it.
      if (playlist.includes('#EXT-X-STREAM-INF')) return true;
      const segment = playlist
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (!segment) return false;
      const head = await ctx.fetch(resolveUrl(url, segment), {
        headers: { ...headers, Range: 'bytes=0-4095' },
      });
      return head.ok && segmentPlayable(await head.text());
    } catch {
      return false;
    }
  })();
  // The host fetch has no timeout and a dead CDN hangs rather than refusing; cap it so one
  // dead server cannot push the whole call past the app's provider deadline.
  const timeout = sleep(PROBE_TIMEOUT_MS).then(() => false);
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
      const r = await ctx.fetch(server.token, {
        headers: { 'User-Agent': UA, Referer: page },
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { iv?: unknown; token?: unknown };
      if (typeof data.iv !== 'string' || typeof data.token !== 'string') continue;
      const token = decryptXyzToken(xyz.secret, data.iv, data.token);
      if (!token) continue;
      return {
        url: `${server.playlist}?token=${encodeURIComponent(token)}&server=${xyz.serverParam}`,
        page,
      };
    } catch (error) {
      ctx.log.debug('xyzstreams token failed', server.token, String(error));
    }
  }
  return undefined;
}

/**
 * Follow an embed through nested iframes and obfuscation to its HLS URLs. Some players list
 * several CDNs for one stream (xstream.st names three instreams.* hosts), so all are returned.
 */
async function resolveEmbed(
  ctx: PluginContext,
  embedUrl: string,
  referer: string,
): Promise<{ urls: string[]; page: string } | undefined> {
  let url = embedUrl;
  let ref = referer;
  for (let hop = 0; hop < MAX_EMBED_HOPS; hop++) {
    const response = await ctx.fetch(url, {
      headers: { 'User-Agent': UA, Referer: ref },
    });
    if (!response.ok) {
      ctx.log.debug('Embed', url, 'answered', response.status);
      return undefined;
    }
    const page = response.url || url;
    const html = await response.text();
    const xyz = parseXyzEmbed(html, page);
    if (xyz) {
      const resolved = await resolveXyz(ctx, xyz, page);
      return resolved && { urls: [resolved.url], page };
    }
    const direct = findAllM3u8(html);
    const urls = direct.length ? direct : decodeEvalBlobs(html).flatMap(findAllM3u8);
    if (urls.length) return { urls, page };
    const next = findIframeSrc(html, page);
    if (!next) return undefined;
    ref = page;
    url = next;
  }
  return undefined;
}

/** The first URL whose playlist loads, probing them all at once. */
async function firstLoading(
  ctx: PluginContext,
  urls: readonly string[],
  headers: Record<string, string>,
): Promise<string | undefined> {
  const ok = await Promise.all(urls.map((url) => playlistLoads(ctx, url, headers)));
  return urls[ok.indexOf(true)];
}

export default definePlugin({
  provider: {
    async getStreams(game, ctx): Promise<StreamCandidate[]> {
      const deadline = sleep(STREAMS_BUDGET_MS);
      // Streameast keeps listing a game after it ends while reusing its channel for the next
      // match (seen: a final Broncos @ 49ers page streaming Chiefs @ Raiders). It is live-only,
      // so an ended or called-off game can only ever yield the wrong broadcast.
      if (game.status === 'final' || game.status === 'cancelled' || game.status === 'postponed') {
        return [];
      }
      const picked = pickMatch(game, await loadMatches(ctx));
      if (!picked) return [];
      const { match, confidence } = picked;

      // A mirror can serve a page without the player (rate limited, or a stale cache), so a
      // page only counts once it has one.
      const mirrors = knownMirrors();
      const landing = await fetchFromMirrors(ctx, mirrors, match.path, (html) => {
        const page = parseSources(html);
        return page.iframe ? page : undefined;
      });
      if (!landing) {
        ctx.log.info('No player yet for', titleOf(match), '(not live, or premium only).');
        return [];
      }
      const page = landing.value;

      const servers = page.free.length
        ? page.free
        : [{ index: 1, name: 'Server 1', path: match.path }];
      // The app abandons the whole call at 15 s and shows nothing, so each server races a shared
      // deadline: servers that resolved in time are returned, slow ones are dropped. Dead CDNs
      // hang rather than refuse, so once one server works the rest get a short grace, not the
      // whole budget, and the user is not left waiting on a server that will never answer.
      let firstFound!: () => void;
      const grace = new Promise<void>((resolve) => (firstFound = resolve)).then(() =>
        sleep(GRACE_AFTER_FIRST_MS),
      );
      const cutoff = Promise.race([deadline, grace]).then(() => undefined);
      const results = await Promise.all(
        servers.map((server, i) =>
          Promise.race([
            resolveServer(server, i).then((c) => {
              if (c) firstFound();
              return c;
            }),
            cutoff,
          ]),
        ),
      );
      return results.filter((c): c is StreamCandidate => c !== undefined);

      async function resolveServer(
        server: { index: number; name: string; path: string },
        i: number,
      ): Promise<StreamCandidate | undefined> {
        try {
          let iframe = page.iframe;
          if (page.free.length && server.index !== (page.activeIndex ?? 1)) {
            // Each server starts on a different mirror, so one page load per server does not
            // pile onto a single host's rate limit.
            const order = [...mirrors.slice(i % mirrors.length), ...mirrors.slice(0, i % mirrors.length)];
            const hit = await fetchFromMirrors(ctx, order, server.path, (html) => parseSources(html).iframe);
            iframe = hit?.value;
          }
          if (!iframe) return undefined;
          const resolved = await resolveEmbed(ctx, iframe, `${landing!.mirror}/`);
          if (!resolved) {
            ctx.log.info('Could not read', server.name, 'embed', iframe);
            return undefined;
          }
          const origin = originOf(resolved.page);
          const headers = {
            'User-Agent': UA,
            Referer: `${origin}/`,
            Origin: origin,
          };
          const url = await firstLoading(ctx, resolved.urls, headers);
          if (!url) {
            ctx.log.info(server.name, 'playlist did not load; skipping', resolved.urls.join(' '));
            return undefined;
          }
          return {
            url,
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
      }
    },

    async getChannels(ctx): Promise<Channel[]> {
      const matches = await loadMatches(ctx);
      return matches.map((m) => ({
        id: m.path,
        name: titleOf(m),
        ...(m.espnPath ? { group: m.espnPath.split('/').pop()!.toUpperCase() } : {}),
      }));
    },
  },
});
