/**
 * CoinDex Pro — API proxy Worker
 */

const UPSTREAMS = {
  coingecko:     'https://api.coingecko.com/api/v3',
  dexscreener:   'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com',
  'pulse-rpc':   'https://rpc.pulsechain.com',
  'pulse-scan':  'https://api.scan.pulsechain.com',
  altme:         'https://api.alternative.me',
  cryptocompare: 'https://min-api.cryptocompare.com',
};

const ALLOWED_HOSTS = new Set(Object.values(UPSTREAMS).map(u => new URL(u).host));

const CACHE_TTL = {
  'api.coingecko.com':      120,  // increased from 30s to 2 minutes
  'api.dexscreener.com':     60,  // increased from 20s to 1 minute
  'api.geckoterminal.com':   60,  // increased from 25s to 1 minute
  'api.scan.pulsechain.com': 30,  // increased from 15s to 30s
  'api.alternative.me':     600,  // Fear & Greed — 10 minutes
  'rpc.pulsechain.com':       0,  // never cache JSON-RPC
  'min-api.cryptocompare.com': 60,  // live news — 1 minute
};

// ---- RSS news feeds (no API key required) ----
// Each feed is fetched, its XML parsed server-side, and returned as clean JSON
// in the SAME shape the frontend already consumes for CryptoCompare:
//   { Data: [ { title, url, source, published_on, categories } ] }
// published_on is a UNIX seconds timestamp (matches CryptoCompare).
const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss',                   source: 'Cointelegraph' },
  { url: 'https://decrypt.co/feed',                         source: 'Decrypt' },
];
const RSS_CACHE_TTL = 300;  // 5 minutes — news doesn't need to be fresher than this

const ALLOWED_ORIGINS = [
  'https://coindexpro.com',
  'https://www.coindexpro.com',
];
const ALLOW_ANY_ORIGIN = true;

function corsHeaders(origin) {
  const allow = ALLOW_ANY_ORIGIN
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ---- RSS/XML helpers ----------------------------------------------------
// Minimal, dependency-free RSS + Atom parser. Workers have no DOMParser, so we
// extract items with regex. This is intentionally tolerant: feeds vary, and we
// only need a handful of fields. Anything we can't parse is skipped, not fatal.

// Repair "mojibake": UTF-8 bytes that arrived decoded as Latin-1 OR Windows-1252.
// Feeds are UTF-8, but the byte stream sometimes reaches us mis-decoded, so smart
// punctuation (’ “ ” — …) and accents (é ñ) show up as sequences like â€™.
// The tricky part: in cp1252, bytes 0x80-0x9F map to high code points (€=U+20AC,
// ™=U+2122, ‘=U+2018 …), so a naive "char code = byte" fails. We reverse that
// table to recover the original bytes, then decode the byte array as UTF-8.
// Handles both the Latin-1 (≤0xFF) and Windows-1252 (>0xFF) mis-decode cases.
const CP1252_REV = {
  0x20AC:0x80, 0x201A:0x82, 0x0192:0x83, 0x201E:0x84, 0x2026:0x85,
  0x2020:0x86, 0x2021:0x87, 0x02C6:0x88, 0x2030:0x89, 0x0160:0x8A,
  0x2039:0x8B, 0x0152:0x8C, 0x017D:0x8E, 0x2018:0x91, 0x2019:0x92,
  0x201C:0x93, 0x201D:0x94, 0x2022:0x95, 0x2013:0x96, 0x2014:0x97,
  0x02DC:0x98, 0x2122:0x99, 0x0161:0x9A, 0x203A:0x9B, 0x0153:0x9C,
  0x017E:0x9E, 0x0178:0x9F,
};
function fixMojibake(s) {
  if (!s) return s;
  // Cheap pre-check: a UTF-8 lead byte mis-shown as Latin-1 is in U+00C2..U+00F4.
  // If none present, there's nothing to repair.
  if (!/[\u00c2-\u00f4]/.test(s)) return s;
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp <= 0xff) { bytes.push(cp); }
    else if (CP1252_REV[cp] !== undefined) { bytes.push(CP1252_REV[cp]); }
    else { return s; }  // a genuine multibyte char we can't byte-map — leave it alone
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    if (decoded.indexOf('\ufffd') !== -1) return s;  // produced garbage — keep original
    return decoded;
  } catch (e) {
    return s;
  }
}

function decodeEntities(s) {
  if (!s) return '';
  return fixMojibake(s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')   // do amp LAST so we don't double-decode
    .replace(/<[^>]+>/g, '')  // strip any leftover inline tags
    .trim());
}

function pickTag(block, tag) {
  // matches <tag ...>VALUE</tag> (first occurrence), case-insensitive
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function pickAtomLink(block) {
  // Atom: <link href="..." />  (prefer rel="alternate" or no rel)
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  let href = '';
  for (const l of links) {
    const rel = (l.match(/rel=["']([^"']+)["']/i) || [])[1] || 'alternate';
    const h = (l.match(/href=["']([^"']+)["']/i) || [])[1] || '';
    if (h && (rel === 'alternate')) { href = h; break; }
    if (h && !href) href = h;
  }
  return href;
}

function parseDate(block) {
  const raw = pickTag(block, 'pubDate') || pickTag(block, 'published') ||
              pickTag(block, 'updated') || pickTag(block, 'dc:date');
  if (!raw) return Math.floor(Date.now() / 1000);
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function parseFeed(xml, source) {
  const out = [];
  // RSS uses <item>, Atom uses <entry>. Handle both.
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m => m[0])
    : [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0]);

  for (const block of blocks) {
    const title = decodeEntities(pickTag(block, 'title'));
    if (!title) continue;
    let link = isAtom ? pickAtomLink(block) : decodeEntities(pickTag(block, 'link'));
    if (!link) {
      // some RSS feeds put the URL in <guid isPermaLink="true">
      const guid = decodeEntities(pickTag(block, 'guid'));
      if (/^https?:\/\//i.test(guid)) link = guid;
    }
    if (!link) continue;

    // categories: collect <category> tokens, pipe-delimit to match CryptoCompare's shape
    const cats = [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map(m => decodeEntities(m[1])).filter(Boolean);
    // also pull category from atom term="" attributes
    const atomCats = [...block.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)]
      .map(m => decodeEntities(m[1])).filter(Boolean);
    const categories = [...new Set([...cats, ...atomCats])].join('|');

    out.push({
      title,
      url: link.trim(),
      source,
      published_on: parseDate(block),
      categories,
    });
  }
  return out;
}

async function handleRss(origin, ctx, debug) {
  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }
  const cacheKey = new Request('https://rss.internal/aggregate', { method: 'GET' });

  if (cache && !debug) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
        h.set('X-Proxy-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) { /* miss — continue */ }
  }

  // Fetch all feeds in parallel; tolerate individual failures.
  const settled = await Promise.allSettled(RSS_FEEDS.map(async (feed) => {
    const r = await fetch(feed.url, {
      headers: { 'User-Agent': 'coindex-proxy/1.0', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!r.ok) throw new Error(feed.source + ' HTTP ' + r.status);
    const xml = await r.text();
    return parseFeed(xml, feed.source);
  }));

  let all = [];
  const diag = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') { all = all.concat(s.value); diag.push(RSS_FEEDS[i].source + ':' + s.value.length); }
    else { diag.push(RSS_FEEDS[i].source + ':ERR'); }
  });

  // newest first, de-dupe by title, cap the list
  all.sort((a, b) => b.published_on - a.published_on);
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const k = item.title.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(item);
    if (deduped.length >= 60) break;
  }

  // ---- debug: expose raw char codes so we can diagnose encoding without guessing ----
  if (debug) {
    // find the first deduped title that still shows a suspicious char, else first title
    const sample = deduped.find(d => /[\u0080-\uffff]/.test(d.title)) || deduped[0] || { title: '' };
    const t = sample.title || '';
    const codes = [...t].map((ch, idx) => ({ i: idx, ch, hex: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') }))
      .filter(c => c.ch.codePointAt(0) > 0x7e);  // only non-ASCII, the interesting ones
    const dbg = {
      note: 'char codes >0x7E in first suspicious title (AFTER fixMojibake ran)',
      title: t,
      suspicious_codes: codes,
      diag: diag.join(','),
      total: deduped.length,
    };
    return new Response(JSON.stringify(dbg, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const payload = { Data: deduped, _diag: diag.join(',') };
  const respHeaders = new Headers({ 'Content-Type': 'application/json' });
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
  respHeaders.set('X-Proxy-Cache', 'MISS');

  if (cache && deduped.length) {
    try {
      respHeaders.set('Cache-Control', `public, max-age=${RSS_CACHE_TTL}`);
      const body = JSON.stringify(payload);
      const cacheResp = new Response(body, { status: 200, headers: respHeaders });
      ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
      return new Response(body, { status: 200, headers: respHeaders });
    } catch (e) { /* fall through to uncached return */ }
  }

  return new Response(JSON.stringify(payload), { status: 200, headers: respHeaders });
}

function resolveTarget(url) {
  const passthrough = url.searchParams.get('url');
  if (passthrough) {
    let u;
    try { u = new URL(passthrough); } catch { return null; }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)) return null;
    return u;
  }
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  const key = parts.shift();
  const base = UPSTREAMS[key];
  if (!base) return null;
  const rest = parts.join('/');
  const target = new URL(base + (rest ? '/' + rest : ''));
  url.searchParams.forEach((v, k) => { if (k !== 'url') target.searchParams.set(k, v); });
  return target;
}

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (reqUrl.pathname === '/' && !reqUrl.searchParams.get('url')) {
      return json(200, { ok: true, service: 'coindex-proxy', upstreams: Object.keys(UPSTREAMS) }, origin);
    }

    // ---- RSS news aggregation route (no upstream key needed) ----
    if (reqUrl.pathname === '/rss' || reqUrl.pathname === '/rss/') {
      if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' }, origin);
      }
      try {
        const debug = reqUrl.searchParams.get('debug') === '1';
        return await handleRss(origin, ctx, debug);
      } catch (e) {
        return json(502, { error: 'rss aggregate failed', detail: String(e) }, origin);
      }
    }

    const target = resolveTarget(reqUrl);
    if (!target) {
      return json(403, { error: 'upstream not allowed' }, origin);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'method not allowed' }, origin);
    }

    const ttl = CACHE_TTL[target.host] ?? 0;
    const isGet = request.method === 'GET';
    let cache = null;
    try { cache = caches.default; } catch (e) { cache = null; }
    const cacheKey = new Request(target.toString(), { method: 'GET' });

    if (isGet && ttl > 0 && cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const h = new Headers(hit.headers);
          Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
          h.set('X-Proxy-Cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      } catch (e) { /* cache miss, continue to fetch */ }
    }

    const headers = new Headers();
    headers.set('Accept', target.host === 'api.geckoterminal.com'
      ? 'application/json;version=20230302'
      : 'application/json');
    headers.set('User-Agent', 'coindex-proxy/1.0');
    if (target.host === 'api.coingecko.com') {
      headers.set('x-cg-demo-api-key', 'CG-ZVVrjRSx8dSxoymn89vzF6C2');
    }
    // CryptoCompare (CCData) news auth: key goes in the Authorization header as
    // "Apikey <KEY>", pulled from the CRYPTOCOMPARE_API_KEY secret. The news
    // endpoint also works key-less at a lower rate limit, so if the secret is
    // missing we still attempt the call rather than failing outright.
    if (target.host === 'min-api.cryptocompare.com') {
      const token = (env && env.CRYPTOCOMPARE_API_KEY) || '';
      if (token) headers.set('authorization', 'Apikey ' + token);
    }

    const init = { method: request.method, headers };
    if (request.method === 'POST') {
      headers.set('Content-Type', 'application/json');
      init.body = await request.text();
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      return json(502, { error: 'upstream fetch failed', detail: String(e) }, origin);
    }

    const respHeaders = new Headers();
    respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
    respHeaders.set('X-Proxy-Cache', 'MISS');

    // Read the body ONCE into a single buffer. Serve that buffer to the client
    // and (for cacheable GETs) store a copy in cache. One allocation — memory-safe,
    // and crucially the client always gets the COMPLETE body (no tee backpressure /
    // truncation, which was breaking the large 250-coin markets response on mobile).
    let bodyText;
    try {
      bodyText = await upstream.text();
    } catch (e) {
      // If we somehow can't read the body, fall back to a raw passthrough.
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    if (isGet && ttl > 0 && upstream.ok && cache) {
      try {
        respHeaders.set('Cache-Control', `public, max-age=${ttl}`);
        const cacheResp = new Response(bodyText, { status: upstream.status, headers: respHeaders });
        ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
      } catch (e) { /* cache write failed — still serve the client below */ }
    }

    return new Response(bodyText, { status: upstream.status, headers: respHeaders });
  },
};
