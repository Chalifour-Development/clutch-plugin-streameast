/**
 * Pure string parsers for Streameast pages and the embeds they use. They are
 * regex based on purpose: the QuickJS sandbox has no DOM, and a bundled HTML
 * parser would cost more than these few well-defined shapes need.
 */

export interface Match {
  espnEventId?: string;
  espnPath?: string;
  /** Unix seconds. */
  startsAt: number;
  teams: string[];
  path: string;
  proOnly: boolean;
}

export interface Source {
  index: number;
  name: string;
  path: string;
}

export interface MatchPage {
  free: Source[];
  activeIndex?: number;
  iframe?: string;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Every `div.m-card` on a listing page. */
export function parseMatches(html: string): Match[] {
  const out: Match[] = [];
  const seen = new Set<string>();
  const re = /<div\s+class="m-card[\s"][^>]*>/g;
  for (const m of html.matchAll(re)) {
    const a = attrs(m[0]);
    const after = html.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    const link = /<a\s+class="m-card__link"[^>]*href="([^"]+)"/.exec(after);
    const startsAt = Number(a['data-time']);
    if (!link || !Number.isFinite(startsAt)) continue;
    const path = decodeEntities(link[1]!);
    if (seen.has(path)) continue;
    seen.add(path);
    const teams = (a['data-team-names'] ?? '').split('|').map((t) => t.trim()).filter(Boolean);
    out.push({
      ...(a['data-espn-event-id'] ? { espnEventId: a['data-espn-event-id'] } : {}),
      ...(a['data-espn-path'] ? { espnPath: a['data-espn-path'] } : {}),
      startsAt,
      teams,
      path,
      proOnly: a['data-pro-only'] === '1',
    });
  }
  return out;
}

/** Source list and active player iframe of a match page. */
export function parseSources(html: string): MatchPage {
  const free: Source[] = [];
  let activeIndex: number | undefined;
  for (const m of html.matchAll(/<a\s+class="(stream-alt-item[^"]*)"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const cls = m[1]!;
    const path = decodeEntities(m[2]!);
    const index = Number(/\/(\d+)\/?$/.exec(path)?.[1]);
    if (!Number.isFinite(index)) continue;
    if (/\bactive\b/.test(cls)) activeIndex = index;
    if (/stream-alt-item-pro/.test(cls)) continue;
    const name = /stream-alt-name">([\s\S]*?)<\/span>/.exec(m[3]!);
    free.push({ index, name: name ? stripTags(name[1]!) : `Server ${index}`, path });
  }
  const tag = /<iframe\b[^>]*\bid=["']iframe["'][^>]*>/i.exec(html);
  const src = tag ? attrs(tag[0]).src : undefined;
  return {
    free,
    ...(activeIndex !== undefined ? { activeIndex } : {}),
    ...(src && /^(https?:)?\/\//.test(src) ? { iframe: absolutize(src) } : {}),
  };
}

function absolutize(src: string, base?: string): string {
  if (src.startsWith('//')) return `https:${src}`;
  if (/^https?:\/\//.test(src) || !base) return src;
  const origin = /^https?:\/\/[^/]+/.exec(base)?.[0] ?? '';
  return src.startsWith('/') ? origin + src : base.replace(/[^/]*$/, '') + src;
}

/** First non-blank http(s) iframe src in an embed page. */
export function findIframeSrc(html: string, base?: string): string | undefined {
  for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const src = attrs(m[0]).src?.trim();
    if (!src || src === 'about:blank' || src.startsWith('javascript:')) continue;
    return absolutize(src, base);
  }
  return undefined;
}

function unescapeJs(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

/** First absolute .m3u8 URL written as a literal in the text. */
export function findM3u8(text: string): string | undefined {
  const m = /https?:(?:\\?\/){2}[^"'`\s<>]+?\.m3u8(?:\?[^"'`\s<>]*)?(?=["'`\s<>]|$)/.exec(text);
  return m ? decodeEntities(unescapeJs(m[0])) : undefined;
}

/**
 * Decode `var a=[..bytes..],x=N,k=M ... String.fromCharCode(((a[i]^x)-k+256)%256) ... eval`
 * style obfuscation. Returns every decoded script so callers can search them.
 */
export function decodeEvalBlobs(html: string): string[] {
  const out: string[] = [];
  const re =
    /=\[((?:\d{1,3},){20,}\d{1,3})\]((?:,\s*[\w$]+\s*=\s*\d+){2})[\s\S]{0,400}?\(\(\s*[\w$]+\[[\w$]+\]\s*\^\s*([\w$]+)\s*\)\s*-\s*([\w$]+)\s*\+\s*256\s*\)\s*%\s*256/g;
  for (const m of html.matchAll(re)) {
    const bytes = m[1]!.split(',').map(Number);
    const vars = new Map([...m[2]!.matchAll(/([\w$]+)\s*=\s*(\d+)/g)].map((n) => [n[1]!, Number(n[2])]));
    const xor = vars.get(m[3]!);
    const sub = vars.get(m[4]!);
    if (xor === undefined || sub === undefined) continue;
    let s = '';
    for (const b of bytes) s += String.fromCharCode((((b ^ xor) - sub) + 256) % 256);
    out.push(s);
  }
  return out;
}
