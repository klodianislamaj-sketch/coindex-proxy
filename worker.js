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
  'api.coingecko.com':      30,
  'api.dexscreener.com':    20,
  'api.geckoterminal.com':  25,
  'api.scan.pulsechain.com':15,
  'api.alternative.me':    300,
  'rpc.pulsechain.com':      0,
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
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)
