/**
 * CoinDex Pro — API proxy Worker
 */

const UPSTREAMS = {
  coingecko:     'https://api.coingecko.com',
  dexscreener:   'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com',
  'pulse-rpc':   'https://rpc.pulsechain.com',
  'pulse-scan':  'https://api.scan.pulsechain.com',
  altme:         'https://api.alternative.me',
};

const ALLOWED_HOSTS = new Set(Object.values(UPSTREAMS).map(u => new URL(u).host));

const CACHE_TTL = {
  'api.coingecko.com':      120,  // increased from 30s to 2 minutes
  'api.dexscreener.com':     60,  // increased from 20s to 1 minute
  'api.geckoterminal.com':   60,  // increased from 25s to 1 minute
  'api.scan.pulsechain.com': 30,  // increased from 15s to 30s
  'api.alternative.me':     600,  // Fear & Greed — 10 minutes
  'rpc.pulsechain.com':       0,  // never cache JSON-RPC
};

const ALLOWED_ORIGINS = [
  'https://coindexpro.com',
  'https://www.coindexpro.com',
];
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
  async fetch(request, ctx) {
    const reqUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (reqUrl.pathname === '/' && !reqUrl.searchParams.get('url')) {
      return json(200, { ok: true, service: 'coindex-proxy', upstreams: Object.keys(UPSTREAMS) }, origin);
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

    const body = await upstream.arrayBuffer();
    const respHeaders = new Headers();
    respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
    respHeaders.set('X-Proxy-Cache', 'MISS');

    if (isGet && ttl > 0 && upstream.ok && cache) {
      try {
        respHeaders.set('Cache-Control', `public, max-age=${ttl}`);
        const toCache = new Response(body.slice(0), { status: upstream.status, headers: respHeaders });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      } catch (e) { /* cache write failed, ignore */ }
    }

    return new Response(body, { status: upstream.status, headers: respHeaders });
  },
};
