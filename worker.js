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
  blockchair:    'https://api.blockchair.com',
  blockchaininfo:'https://blockchain.info',
  ethplorer:     'https://api.ethplorer.io',
  deribit:       'https://www.deribit.com',
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
  'api.blockchair.com':       60,  // big-chain whale feed (keyless, 1000/day) — 1 minute
  'blockchain.info':          30,  // BTC whale feed (keyless, CORS) — 30s
  'api.ethplorer.io':         25,  // ETH/ERC-20 whale feed (freekey) — 25s
  'www.deribit.com':          45,  // BTC/ETH options chain — 45s (30–60s window)
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

// ---- ETF flows (Farside Investors, public HTML tables, no key) ----
// We fetch the public flow page, parse the HTML table server-side, and return
// clean JSON: latest reported day's per-fund flows + total, plus recent history.
// Values are US$m. Negatives render in parentheses on the page; "-" means a day
// not yet reported. Flows update once per trading day, so cache generously.
const ETF_FEEDS = {
  btc: { url: 'https://farside.co.uk/btc/', label: 'Bitcoin' },
  eth: { url: 'https://farside.co.uk/eth/', label: 'Ethereum' },
};
const ETF_CACHE_TTL = 1800;  // 30 minutes — daily data, no need to refetch often

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
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
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

async function handleRss(origin, ctx) {
  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }
  const cacheKey = new Request('https://rss.internal/aggregate', { method: 'GET' });

  if (cache) {
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

  const payload = { Data: deduped, _diag: diag.join(',') };
  const respHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
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

// ---- ETF flow parsing (Farside HTML table) --------------------------------
// Parse a US$m flow value as it appears in the table:
//   "(177.9)" -> -177.9   |   "0.0" -> 0   |   "-" or "" -> null (not reported)
//   "1,373.8" -> 1373.8   (thousands separators stripped)
function parseFlowCell(raw) {
  if (raw == null) return null;
  let s = raw.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, '').trim();
  if (s === '' || s === '-' || s === '\u2013' || s === '\u2014') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '.' || s === '-') return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Pull <td>/<th> cell inner texts from one <tr> block.
function parseRowCells(rowHtml) {
  const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim());
  return cells;
}

const ETF_DATE_RE = /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/;  // e.g. "15 Jun 2026"

function parseEtfTable(html) {
  // WordPress pages can contain several <table> elements (layout, widgets, then
  // the data table). Scan ALL tables and parse the first one that actually yields
  // date rows. Also tolerate <tbody>, cell attributes/classes, and <th> cells.
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(m => m[0]);
  if (!tables.length) return null;

  for (const table of tables) {
    const result = parseOneTable(table);
    if (result && result.history.length) return finalizeEtf(result);
  }
  return null;
}

function parseOneTable(table) {
  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  let tickers = null;
  const history = [];

  for (const row of rows) {
    const cells = parseRowCells(row);
    if (!cells.length) continue;
    const first = cells[0];

    // Ticker header row: a row whose cells (after the first) are mostly short
    // uppercase codes. Detected independently of the first cell being empty.
    if (!tickers) {
      const candidate = cells.slice(1).map(c => c.trim());
      const tickerLike = candidate.filter(c => /^[A-Z]{2,6}$/.test(c)).length;
      if (tickerLike >= 3 && !ETF_DATE_RE.test(first)) {
        tickers = candidate.filter(c => c !== '' && c.toLowerCase() !== 'total');
        continue;
      }
    }

    if (ETF_DATE_RE.test(first)) {
      const vals = cells.slice(1).map(parseFlowCell);
      const total = vals.length ? vals[vals.length - 1] : null;
      const funds = {};
      if (tickers) {
        for (let i = 0; i < tickers.length && i < vals.length - 1; i++) {
          const tk = tickers[i];
          if (tk && tk.toLowerCase() !== 'total') funds[tk] = vals[i];
        }
      }
      history.push({ date: first, total, funds });
    }
  }
  return { tickers, history };
}

function finalizeEtf({ tickers, history }) {
  if (!history.length) return null;
  let latestIdx = history.length - 1;
  while (latestIdx > 0) {
    const h = history[latestIdx];
    const hasData = (h.funds && Object.values(h.funds).some(v => v !== null && v !== 0))
                    || (h.total !== null && h.total !== 0);
    if (hasData) break;
    latestIdx--;
  }
  const latest = history[latestIdx];
  const recent = history.slice(Math.max(0, history.length - 30));
  return { latest, recent, tickers: tickers || [] };
}


async function handleEtf(which, origin, ctx, debug) {
  const feed = ETF_FEEDS[which];
  if (!feed) return json(404, { error: 'unknown etf feed' }, origin);

  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }
  const cacheKey = new Request('https://etf.internal/' + which, { method: 'GET' });

  if (cache && !debug) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
        h.set('X-Proxy-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) { /* miss */ }
  }

  let html;
  try {
    const r = await fetch(feed.url, {
      headers: { 'User-Agent': 'coindex-proxy/1.0', 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    html = await r.text();
  } catch (e) {
    return json(502, { error: 'etf fetch failed', detail: String(e) }, origin);
  }

  if (debug) {
    const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(m => m[0]);
    const firstRows = tables.length
      ? [...tables[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].slice(0, 4).map(m => m[0])
      : [];
    return json(200, {
      debug: true, asset: which,
      htmlLength: html.length,
      tableCount: tables.length,
      hasTr: /<tr\b/i.test(html),
      hasTd: /<td\b/i.test(html),
      // show a slice of the page so we can see real structure
      sample: html.slice(0, 1500),
      firstTableRows: firstRows.map(r => r.slice(0, 300)),
    }, origin);
  }

  const parsed = parseEtfTable(html);
  if (!parsed) {
    return json(502, { error: 'etf parse failed', asset: which }, origin);
  }

  const payload = { asset: which, label: feed.label, unit: 'US$m', ...parsed };
  const respHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
  respHeaders.set('X-Proxy-Cache', 'MISS');

  if (cache) {
    try {
      respHeaders.set('Cache-Control', `public, max-age=${ETF_CACHE_TTL}`);
      const body = JSON.stringify(payload);
      const cacheResp = new Response(body, { status: 200, headers: respHeaders });
      ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
      return new Response(body, { status: 200, headers: respHeaders });
    } catch (e) { /* fall through */ }
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

// ============================================================================
// PHASE 3A — persistence-backed systems. All helpers degrade gracefully when
// env.DB / env.CACHE are unbound (return honest "unavailable", never fabricate).
// Self-contained so the worker stays single-file deployable.
// ============================================================================

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }
const NOW = () => Date.now();

// ---- tiny D1 wrappers (inline; mirror db.js) -------------------------------
async function dbGet(env, sql, params = []) {
  if (!_dbOk(env)) return null;
  try { return await env.DB.prepare(sql).bind(...params).first(); } catch (e) { return null; }
}
async function dbAll(env, sql, params = []) {
  if (!_dbOk(env)) return [];
  try { const r = await env.DB.prepare(sql).bind(...params).all(); return (r && r.results) || []; }
  catch (e) { return []; }
}
async function dbRun(env, sql, params = []) {
  if (!_dbOk(env)) return { ok: false, error: 'db-unbound' };
  try { const r = await env.DB.prepare(sql).bind(...params).run(); return { ok: true, meta: r && r.meta }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ---- 1) TOKEN SECURITY CACHE (real GoPlus) ---------------------------------
const SEC_FRESH_MS = 6 * 3600 * 1000;     // <6h  → serve cache
const SEC_STALE_MS = 24 * 3600 * 1000;    // 6–24h → serve + background refresh; >24h → blocking

// Map our chain id to GoPlus chain id (GoPlus uses numeric EVM chain ids).
function goplusChainId(chain) {
  const m = { '1': '1', 'eth': '1', 'ethereum': '1', 'bsc': '56', '56': '56',
              'polygon': '137', '137': '137', 'arbitrum': '42161', '42161': '42161',
              'base': '8453', '8453': '8453', 'avalanche': '43114', '43114': '43114' };
  return m[String(chain).toLowerCase()] || String(chain);
}

// Fetch a real GoPlus token-security result. Returns { ok, score, flags, raw } or
// { ok:false }. Never invents fields — score derives only from real GoPlus flags.
async function fetchGoPlus(chain, address) {
  const cid = goplusChainId(chain);
  const url = `https://api.gopluslabs.io/api/v1/token_security/${cid}?contract_addresses=${encodeURIComponent(address.toLowerCase())}`;
  let resp;
  try { resp = await fetch(url, { headers: { 'Accept': 'application/json' } }); }
  catch (e) { return { ok: false, error: 'fetch-failed' }; }
  if (!resp.ok) return { ok: false, error: 'http-' + resp.status };
  let data;
  try { data = await resp.json(); } catch (e) { return { ok: false, error: 'bad-json' }; }
  const result = data && data.result && data.result[address.toLowerCase()];
  if (!result) return { ok: false, error: 'no-result' };
  // Derive a 0–100 security score from REAL risk flags. Each present risk lowers it.
  const riskFlags = [
    'is_honeypot', 'honeypot_with_same_creator', 'cannot_sell_all', 'is_blacklisted',
    'is_whitelisted', 'is_proxy', 'is_mintable', 'can_take_back_ownership',
    'owner_change_balance', 'hidden_owner', 'selfdestruct', 'external_call',
    'trading_cooldown', 'is_anti_whale', 'slippage_modifiable', 'transfer_pausable'
  ];
  const flags = {};
  let penalties = 0;
  for (const f of riskFlags) {
    if (result[f] === '1') { flags[f] = true; penalties += (f === 'is_honeypot' || f === 'cannot_sell_all') ? 40 : 8; }
  }
  // buy/sell tax as real numbers if present
  const buyTax = parseFloat(result.buy_tax); const sellTax = parseFloat(result.sell_tax);
  if (isFinite(buyTax) && buyTax > 0.1) { flags.high_buy_tax = buyTax; penalties += Math.min(20, buyTax * 100 * 0.5); }
  if (isFinite(sellTax) && sellTax > 0.1) { flags.high_sell_tax = sellTax; penalties += Math.min(20, sellTax * 100 * 0.5); }
  const score = Math.max(0, Math.min(100, 100 - penalties));
  return { ok: true, score, flags, raw: result };
}

// Upsert a security row + write audit on score change. Returns the row id.
async function persistSecurity(env, chain, address, score, flags, raw) {
  const cid = String(chain), addr = String(address).toLowerCase();
  const existing = await dbGet(env, 'SELECT id, score FROM token_security WHERE chain_id=? AND address=?', [cid, addr]);
  const ts = NOW();
  if (existing) {
    await dbRun(env, 'UPDATE token_security SET score=?, flags_json=?, raw_json=?, updated_at=? WHERE id=?',
      [score, JSON.stringify(flags || {}), JSON.stringify(raw || {}), ts, existing.id]);
    if (existing.score !== score) {
      await dbRun(env, 'INSERT INTO token_security_audit (token_id, old_score, new_score, changed_at) VALUES (?,?,?,?)',
        [existing.id, existing.score, score, ts]);
    }
    return existing.id;
  } else {
    const r = await dbRun(env,
      'INSERT INTO token_security (chain_id, address, score, flags_json, raw_json, updated_at) VALUES (?,?,?,?,?,?)',
      [cid, addr, score, JSON.stringify(flags || {}), JSON.stringify(raw || {}), ts]);
    return r && r.meta && r.meta.last_row_id;
  }
}

// Main handler for GET /api/token/security.
async function handleTokenSecurity(env, ctx, chain, address, origin) {
  if (!chain || !address) return json(400, { error: 'chain and address required' }, origin);
  if (!(env && String(env.GOPLUS_ENABLED) === 'true')) {
    return json(200, { available: false, reason: 'GOPLUS_ENABLED=false', source: 'goplus' }, origin);
  }
  const cid = String(chain), addr = String(address).toLowerCase();
  const row = await dbGet(env, 'SELECT * FROM token_security WHERE chain_id=? AND address=?', [cid, addr]);
  const now = NOW();

  if (row) {
    const age = now - row.updated_at;
    const ageSec = Math.floor(age / 1000);
    const flags = safeParse(row.flags_json, {});
    if (age < SEC_FRESH_MS) {
      return json(200, { cached: true, cacheAgeSeconds: ageSec, score: row.score, flags, source: 'goplus' }, origin);
    }
    if (age < SEC_STALE_MS) {
      // serve stale immediately, refresh in background
      if (ctx && ctx.waitUntil) ctx.waitUntil((async () => {
        const fresh = await fetchGoPlus(cid, addr);
        if (fresh.ok) await persistSecurity(env, cid, addr, fresh.score, fresh.flags, fresh.raw);
      })());
      return json(200, { cached: true, stale: true, cacheAgeSeconds: ageSec, score: row.score, flags, source: 'goplus' }, origin);
    }
    // expired (>24h) → blocking refresh
    const fresh = await fetchGoPlus(cid, addr);
    if (!fresh.ok) {
      // refresh failed — serve last known honestly, flag it
      return json(200, { cached: true, stale: true, refreshFailed: true, cacheAgeSeconds: ageSec, score: row.score, flags, source: 'goplus' }, origin);
    }
    await persistSecurity(env, cid, addr, fresh.score, fresh.flags, fresh.raw);
    return json(200, { cached: false, cacheAgeSeconds: 0, score: fresh.score, flags: fresh.flags, source: 'goplus' }, origin);
  }

  // cache miss → fetch live
  const fresh = await fetchGoPlus(cid, addr);
  if (!fresh.ok) return json(200, { available: false, reason: 'goplus-' + (fresh.error || 'error'), source: 'goplus' }, origin);
  await persistSecurity(env, cid, addr, fresh.score, fresh.flags, fresh.raw);
  return json(200, { cached: false, cacheAgeSeconds: 0, score: fresh.score, flags: fresh.flags, source: 'goplus' }, origin);
}

// ---- 2) PROVIDER HEALTH ENGINE ---------------------------------------------
// Rolling exponential stats per provider. integrity = fraction of well-formed
// payloads; freshness = recency of last success. All real, measured.
async function recordProviderResult(env, provider, ok, latencyMs, rateLimited, malformed) {
  if (!_dbOk(env) || !provider) return;
  const row = await dbGet(env, 'SELECT * FROM provider_health WHERE provider=?', [provider]);
  const a = 0.2; // EMA weight for the new sample
  const now = NOW();
  let success_rate, avg_latency, rate_limit_hits, integrity_score, freshness_score;
  if (row) {
    success_rate    = (1 - a) * row.success_rate    + a * (ok ? 1 : 0);
    avg_latency     = (1 - a) * row.avg_latency      + a * (latencyMs || 0);
    integrity_score = (1 - a) * row.integrity_score  + a * (malformed ? 0 : 1);
    rate_limit_hits = (row.rate_limit_hits || 0) + (rateLimited ? 1 : 0);
    freshness_score = ok ? 1 : Math.max(0, row.freshness_score - 0.1);
  } else {
    success_rate = ok ? 1 : 0; avg_latency = latencyMs || 0;
    integrity_score = malformed ? 0 : 1; rate_limit_hits = rateLimited ? 1 : 0;
    freshness_score = ok ? 1 : 0;
  }
  // latency_score: 1.0 at ≤200ms decaying to 0 at ≥3000ms
  const latency_score = Math.max(0, Math.min(1, 1 - (avg_latency - 200) / 2800));
  const reliability = 0.4 * success_rate + 0.2 * freshness_score + 0.2 * latency_score + 0.2 * integrity_score;
  if (row) {
    await dbRun(env, `UPDATE provider_health SET success_rate=?, avg_latency=?, rate_limit_hits=?,
      integrity_score=?, freshness_score=?, reliability=?, updated_at=? WHERE provider=?`,
      [success_rate, avg_latency, rate_limit_hits, integrity_score, freshness_score, reliability, now, provider]);
  } else {
    await dbRun(env, `INSERT INTO provider_health (provider, success_rate, avg_latency, rate_limit_hits,
      integrity_score, freshness_score, reliability, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [provider, success_rate, avg_latency, rate_limit_hits, integrity_score, freshness_score, reliability, now]);
  }
  // Provider drift: compare current reliability against the ~24h-old KV snapshot.
  // A drop >15% (absolute reliability points) logs a provider_drift anomaly.
  // Schema-free: history lives in KV, not a new table.
  await detectProviderDrift(env, provider, reliability, now);
}

// KV-backed 24h reliability snapshot per provider → drift anomaly on >15% drop.
async function detectProviderDrift(env, provider, reliability, now) {
  if (!_kvOk(env)) return;
  const key = 'provdrift:' + provider;
  let snap = null;
  try { const raw = await env.CACHE.get(key); if (raw) snap = JSON.parse(raw); } catch (e) {}
  const DAY_MS = 86400000;
  // baseline = the snapshot if it's ~24h old; otherwise (re)seed and exit.
  if (snap && snap.ts && (now - snap.ts) >= DAY_MS) {
    const drop = (snap.reliability || 0) - reliability;   // positive = reliability fell
    if (drop > 0.15 && _dbOk(env)) {
      await dbRun(env,
        'INSERT INTO anomalies (token_id, type, severity, details_json, created_at) VALUES (?,?,?,?,?)',
        [null, 'provider_drift', drop > 0.30 ? 'critical' : 'warn',
         JSON.stringify({ subtype: 'provider_drift', provider, from: +(snap.reliability).toFixed(3), to: +reliability.toFixed(3), drop: +(drop).toFixed(3) }), now]);
    }
    // roll the snapshot forward
    try { await env.CACHE.put(key, JSON.stringify({ reliability, ts: now })); } catch (e) {}
  } else if (!snap) {
    // seed the first baseline
    try { await env.CACHE.put(key, JSON.stringify({ reliability, ts: now })); } catch (e) {}
  }
}

// ---- 3) ANOMALY LOGGER -----------------------------------------------------
// Inspect a parsed payload for integrity issues. Writes rows; returns count.
async function detectAnomalies(env, provider, payload) {
  if (!_dbOk(env) || !payload) return 0;
  const anomalies = [];
  const arr = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : null);
  if (arr) {
    const seenSym = new Set();
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const tid = item.id || item.symbol || item.contract_address || null;
      const price = num(item.current_price ?? item.price);
      const mcap = num(item.market_cap);
      const vol = num(item.total_volume ?? item.volume);
      const liq = num(item.liquidity);
      if (price !== null && price <= 0) anomalies.push({ tid, type: 'null_price', sev: 'warn', d: { price } });
      if (mcap !== null && mcap < 0) anomalies.push({ tid, type: 'negative_market_cap', sev: 'critical', d: { mcap } });
      if (vol !== null && liq !== null && liq > 0 && vol / liq > 1000)
        anomalies.push({ tid, type: 'impossible_volume_liquidity_ratio', sev: 'warn', d: { vol, liq } });
      const sym = (item.symbol || '').toLowerCase();
      if (sym) { if (seenSym.has(sym)) anomalies.push({ tid, type: 'duplicate_symbol', sev: 'info', d: { symbol: sym } }); else seenSym.add(sym); }
      const ts = item.last_updated || item.timestamp;
      if (ts && isNaN(Date.parse(ts)) && !(typeof ts === 'number' && ts > 0))
        anomalies.push({ tid, type: 'malformed_timestamp', sev: 'info', d: { ts } });
    }
  }
  for (const an of anomalies.slice(0, 50)) {
    await dbRun(env, 'INSERT INTO anomalies (token_id, type, severity, details_json, created_at) VALUES (?,?,?,?,?)',
      [an.tid ? String(an.tid) : null, an.type, an.sev, JSON.stringify(Object.assign({ provider }, an.d)), NOW()]);
  }
  return anomalies.length;
}

// ---- 4) WATCHLIST PERSISTENCE ----------------------------------------------
async function handleWatchlistSync(env, request, origin) {
  if (!_dbOk(env)) return json(200, { ok: false, available: false, reason: 'db-unbound' }, origin);
  let body; try { body = JSON.parse(await request.text() || '{}'); } catch (e) { return json(400, { error: 'bad json' }, origin); }
  const userId = body.user_id; const incoming = Array.isArray(body.items) ? body.items : [];
  const clientVersion = num(body.version);
  if (!userId) return json(400, { error: 'user_id required' }, origin);

  const row = await dbGet(env, 'SELECT * FROM watchlists WHERE user_id=?', [userId]);
  const now = NOW();
  if (!row) {
    const items = dedupe(incoming);
    await dbRun(env, 'INSERT INTO watchlists (user_id, items_json, version, updated_at) VALUES (?,?,?,?)',
      [userId, JSON.stringify(items), 1, now]);
    return json(200, { ok: true, version: 1, items, merged: items.length }, origin);
  }
  // version conflict protection: if client is behind, still union-merge (no data loss)
  const existing = safeParse(row.items_json, []);
  const merged = dedupe(existing.concat(incoming));
  const newVersion = (row.version || 1) + 1;
  const conflict = (clientVersion !== null && clientVersion < row.version);
  await dbRun(env, 'UPDATE watchlists SET items_json=?, version=?, updated_at=? WHERE user_id=?',
    [JSON.stringify(merged), newVersion, now, userId]);
  return json(200, { ok: true, version: newVersion, items: merged, merged: merged.length, conflictResolved: conflict }, origin);
}
async function handleWatchlistExport(env, userId, origin) {
  if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound' }, origin);
  if (!userId) return json(400, { error: 'user_id required' }, origin);
  const row = await dbGet(env, 'SELECT * FROM watchlists WHERE user_id=?', [userId]);
  if (!row) return json(200, { user_id: userId, items: [], version: 0 }, origin);
  return json(200, { user_id: userId, items: safeParse(row.items_json, []), version: row.version, updated_at: row.updated_at }, origin);
}
async function handleWatchlistImport(env, request, origin) {
  if (!_dbOk(env)) return json(200, { ok: false, available: false, reason: 'db-unbound' }, origin);
  let body; try { body = JSON.parse(await request.text() || '{}'); } catch (e) { return json(400, { error: 'bad json' }, origin); }
  const userId = body.user_id; const incoming = Array.isArray(body.items) ? body.items : [];
  if (!userId) return json(400, { error: 'user_id required' }, origin);
  const row = await dbGet(env, 'SELECT * FROM watchlists WHERE user_id=?', [userId]);
  const now = NOW();
  const existing = row ? safeParse(row.items_json, []) : [];
  const merged = dedupe(existing.concat(incoming));   // union merge + dedupe
  const newVersion = row ? (row.version || 1) + 1 : 1;
  if (row) await dbRun(env, 'UPDATE watchlists SET items_json=?, version=?, updated_at=? WHERE user_id=?', [JSON.stringify(merged), newVersion, now, userId]);
  else await dbRun(env, 'INSERT INTO watchlists (user_id, items_json, version, updated_at) VALUES (?,?,?,?)', [userId, JSON.stringify(merged), 1, now]);
  return json(200, { ok: true, version: newVersion, items: merged, imported: incoming.length, total: merged.length }, origin);
}

// ---- shared small utils ----------------------------------------------------
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function safeParse(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }
function dedupe(items) {
  const seen = new Set(); const out = [];
  for (const it of items) { const k = typeof it === 'object' ? JSON.stringify(it) : String(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (reqUrl.pathname === '/' && !reqUrl.searchParams.get('url')) {
      return json(200, {
        ok: true,
        service: 'coindex-proxy',
        upstreams: Object.keys(UPSTREAMS),
        bindings: {
          db: !!(env && env.DB && typeof env.DB.prepare === 'function'),
          cache: !!(env && env.CACHE && typeof env.CACHE.get === 'function')
        }
      }, origin);
    }

    // ---- RSS news aggregation route (no upstream key needed) ----
    if (reqUrl.pathname === '/rss' || reqUrl.pathname === '/rss/') {
      if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' }, origin);
      }
      try {
        return await handleRss(origin, ctx);
      } catch (e) {
        return json(502, { error: 'rss aggregate failed', detail: String(e) }, origin);
      }
    }

    // ---- ETF flows route: /etf/btc or /etf/eth (Farside, no key) ----
    if (reqUrl.pathname === '/etf' || reqUrl.pathname.startsWith('/etf/')) {
      if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' }, origin);
      }
      const which = (reqUrl.pathname.split('/')[2] || 'btc').toLowerCase();
      try {
        const debug = reqUrl.searchParams.get('debug') === '1';
        return await handleEtf(which, origin, ctx, debug);
      } catch (e) {
        return json(502, { error: 'etf failed', detail: String(e) }, origin);
      }
    }

    // ---- Phase 3 health probes (DB + KV). Honest "unbound" until provisioned. ----
    // These are self-contained so the worker stays single-file deployable. The
    // canonical helpers live in db.js / kv.js for when a proper bundle is used.
    if (reqUrl.pathname === '/api/health/db') {
      const db = env && env.DB;
      if (!db || typeof db.prepare !== 'function') {
        return json(200, { ok: false, bound: false, note: 'D1 binding env.DB not configured yet' }, origin);
      }
      try {
        const row = await db.prepare('SELECT 1 AS ok').first();
        return json(200, { ok: !!(row && row.ok === 1), bound: true }, origin);
      } catch (e) {
        return json(200, { ok: false, bound: true, error: String(e && e.message || e) }, origin);
      }
    }

    if (reqUrl.pathname === '/api/health/cache') {
      const kv = env && env.CACHE;
      if (!kv || typeof kv.get !== 'function') {
        return json(200, { ok: false, bound: false, note: 'KV binding env.CACHE not configured yet' }, origin);
      }
      try {
        const probeKey = '__health_probe__';
        await kv.put(probeKey, '1', { expirationTtl: 60 });
        const val = await kv.get(probeKey);
        await kv.delete(probeKey);
        return json(200, { ok: val === '1', bound: true }, origin);
      } catch (e) {
        return json(200, { ok: false, bound: true, error: String(e && e.message || e) }, origin);
      }
    }

    // ---- Phase 3A: token security cache (real GoPlus) ----
    if (reqUrl.pathname === '/api/token/security') {
      if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, origin);
      return await handleTokenSecurity(env, ctx, reqUrl.searchParams.get('chain'), reqUrl.searchParams.get('address'), origin);
    }

    // ---- Phase 3A: provider health ----
    if (reqUrl.pathname === '/api/providers/health') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', providers: [] }, origin);
      const rows = await dbAll(env, 'SELECT provider, success_rate, avg_latency, rate_limit_hits, integrity_score, freshness_score, reliability, updated_at FROM provider_health ORDER BY reliability DESC');
      return json(200, { providers: rows }, origin);
    }

    // ---- Phase 3A: anomalies log ----
    if (reqUrl.pathname === '/api/anomalies') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', anomalies: [] }, origin);
      const limit = Math.min(200, parseInt(reqUrl.searchParams.get('limit') || '50', 10) || 50);
      const rows = await dbAll(env, 'SELECT id, token_id, type, severity, details_json, created_at FROM anomalies ORDER BY created_at DESC LIMIT ?', [limit]);
      return json(200, { anomalies: rows.map(r => ({ ...r, details: safeParse(r.details_json, {}) })) }, origin);
    }

    // ---- Phase 3A: watchlist persistence ----
    if (reqUrl.pathname === '/api/watchlists/sync' && request.method === 'POST') {
      return await handleWatchlistSync(env, request, origin);
    }
    if (reqUrl.pathname === '/api/watchlists/export' && request.method === 'GET') {
      return await handleWatchlistExport(env, reqUrl.searchParams.get('user_id'), origin);
    }
    if (reqUrl.pathname === '/api/watchlists/import' && request.method === 'POST') {
      return await handleWatchlistImport(env, request, origin);
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
    // Blockchair big-chain whale feed is keyless (1000 calls/day free tier). If a
    // CLANKAPP/BLOCKCHAIR key is ever added later it would go here as ?key=, but
    // none is required for the volumes we use.

    const init = { method: request.method, headers };
    if (request.method === 'POST') {
      headers.set('Content-Type', 'application/json');
      init.body = await request.text();
    }

    let upstream;
    const _t0 = Date.now();
    let _rateLimited = false;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      // record provider failure (best-effort, non-blocking)
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordProviderResult(env, target.host, false, Date.now() - _t0, false, false));
      return json(502, { error: 'upstream fetch failed', detail: String(e) }, origin);
    }
    const _latency = Date.now() - _t0;
    if (upstream.status === 429) _rateLimited = true;

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

    // Phase 3A: provider-health + anomaly tracking (non-blocking, best-effort).
    // Runs only when DB is bound; never delays or alters the client response.
    if (_dbOk(env) && ctx && ctx.waitUntil) {
      let malformed = false, parsed = null;
      const ctype = upstream.headers.get('Content-Type') || '';
      if (ctype.includes('json')) {
        try { parsed = JSON.parse(bodyText); } catch (e) { malformed = true; }
      }
      ctx.waitUntil(recordProviderResult(env, target.host, upstream.ok, _latency, _rateLimited, malformed));
      if (parsed) ctx.waitUntil(detectAnomalies(env, target.host, parsed));
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
