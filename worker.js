/**
 * CoinDex Pro — API proxy Worker
 * ------------------------------------------------------------------
 * Sits between the static frontend (coindexpro.com) and the public
 * market-data APIs. Fixes browser CORS, smooths rate limits via edge
 * caching, and lets the frontend fetch from its own domain.
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create Worker →
 *   paste this → Deploy. Then add a route/custom domain, e.g.
 *   api.coindexpro.com/*  →  this worker.
 *
 * Frontend usage: replace the upstream base URLs with the proxy, keeping
 * the SAME path. Two supported call styles:
 *
 *   1) Host-prefixed path (recommended):
 *        https://api.coindexpro.com/coingecko/api/v3/coins/markets?...
 *        https://api.coindexpro.com/dexscreener/latest/dex/search?q=...
 *        https://api.coindexpro.com/geckoterminal/api/v2/networks/eth/...
 *        https://api.coindexpro.com/pulse-rpc          (POST JSON-RPC)
 *        https://api.coindexpro.com/pulse-scan/api/v2/...
 *        https://api.coindexpro.com/altme/fng/         (Fear & Greed)
 *
 *   2) Full-URL passthrough via ?url= (handy, still whitelisted):
 *        https://api.coindexpro.com/?url=https://api.coingecko.com/api/v3/ping
 *
 * Only the six known upstreams are allowed. Anything else → 403.
 */

const UPSTREAMS = {
  coingecko:     'https://api.coingecko.com',
  dexscreener:   'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com',
  'pulse-rpc':   'https://rpc.pulsechain.com',
  'pulse-scan':  'https://api.scan.pulsechain.com',
  altme:         'https://api.alternative.me',
};

// Host → list of allowed origin hosts (for the ?url= passthrough form)
const ALLOWED_HOSTS = new Set(Object.values(UPSTREAMS).map(u => new URL(u).host));

// Per-host edge cache TTL (seconds). Tunes how hard we lean on cache to
// dodge upstream rate limits. RPC is never cached (state changes per block).
const CACHE_TTL = {
  'api.coingecko.com':      30,   // markets refresh ~60s upstream; 30s is safe
  'api.dexscreener.com':    20,
  'api.geckoterminal.com':  25,
  'api.scan.pulsechain.com':15,
  'api.alternative.me':    300,   // Fear & Greed barely moves
  'rpc.pulsechain.com':      0,   // never cache JSON-RPC
};

// Restrict who may call the proxy. Set to your real origins in production.
const ALLOWED_ORIGINS = [
  'https://coindexpro.com',
  'https://www.coindexpro.com',
];
// During testing you may temporarily allow all with '*'. Tighten before launch.
const ALLOW_ANY_ORIGIN = false;

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

// Build the upstream URL from an incoming request. Returns URL or null.
function resolveTarget(url) {
  // Form 2: ?url=<full upstream url>
  const passthrough = url.searchParams.get('url');
  if (passthrough) {
    let u;
    try { u = new URL(passthrough); } catch { return null; }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)) return null;
    return u;
  }
  // Form 1: /<host-key>/<rest-of-path>
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  const key = parts.shift();
  const base = UPSTREAMS[key];
  if (!base) return null;
  const rest = parts.join('/');
  const target = new URL(base + (rest ? '/' + rest : ''));
  // carry through the query string (minus our own control params)
  url.searchParams.forEach((v, k) => { if (k !== 'url') target.searchParams.set(k, v); });
  return target;
}

export default {
  async fetch(request, ctx) {
    const reqUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    if (reqUrl.pathname === '/' && !reqUrl.searchParams.get('url')) {
      return json(200, { ok: true, service: 'coindex-proxy', upstreams: Object.keys(UPSTREAMS) }, origin);
    }

    const target = resolveTarget(reqUrl);
    if (!target) {
      return json(403, { error: 'upstream not allowed', hint: 'use /<coingecko|dexscreener|geckoterminal|pulse-rpc|pulse-scan|altme>/...' }, origin);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'method not allowed' }, origin);
    }

    const ttl = CACHE_TTL[target.host] ?? 0;
    const isGet = request.method === 'GET';
    const cache = caches.default;
    // Cache key is the target URL (GET only). Keeps cache shared across visitors.
    const cacheKey = new Request(target.toString(), { method: 'GET' });

    if (isGet && ttl > 0) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
        h.set('X-Proxy-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    }

    // Build upstream request. GeckoTerminal needs its versioned Accept header.
    const headers = new Headers();
    headers.set('Accept', target.host === 'api.geckoterminal.com'
      ? 'application/json;version=20230302'
      : 'application/json');
    headers.set('User-Agent', 'coindex-proxy/1.0');

    const init = { method: request.method, headers };
    if (request.method === 'POST') {
      headers.set('Content-Type', 'application/json');
      init.body = await request.text();   // JSON-RPC body for pulse-rpc
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      return json(502, { error: 'upstream fetch failed', detail: String(e) }, origin);
    }

    // Pass body + status through, attach CORS, optionally cache.
    const body = await upstream.arrayBuffer();
    const respHeaders = new Headers();
    respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
    respHeaders.set('X-Proxy-Cache', 'MISS');

    if (isGet && ttl > 0 && upstream.ok) {
      respHeaders.set('Cache-Control', `public, max-age=${ttl}`);
      const toCache = new Response(body.slice(0), { status: upstream.status, headers: respHeaders });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }

    return new Response(body, { status: upstream.status, headers: respHeaders });
  },
};
