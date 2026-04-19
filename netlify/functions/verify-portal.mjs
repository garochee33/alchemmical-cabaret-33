/**
 * Portal invite — PORTAL_CODES in Netlify (comma-separated, case-insensitive).
 * Unset PORTAL_CODES uses legacy list (server-side only).
 */
const LEGACY_CODES = ['33', 'ascension', 'gold', 'rubedo', 'uranus', 'magnum', 'enzo'];

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts;
  return [
    'https://illuminexperience.com',
    'https://www.illuminexperience.com',
    'https://alchemmical-cabaret-33.netlify.app',
  ];
}

function isOriginAllowed(origin) {
  const o = (origin || '').trim();
  if (process.env.NETLIFY_DEV === 'true' && /^http:\/\/localhost:\d+$/.test(o)) return true;
  if (!o) return false;
  const list = parseAllowedOrigins();
  if (list.includes(o)) return true;
  try {
    const h = new URL(o).hostname;
    if (h.endsWith('.netlify.app')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function corsHeaders(origin) {
  const o = (origin || '').trim();
  const allow = isOriginAllowed(o);
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Trinity-Session',
    Vary: 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = o;
  return h;
}

function portalCodes() {
  const raw = process.env.PORTAL_CODES;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return LEGACY_CODES;
}

const RATE_MAP_MAX = 20000;
const rate = new Map();
function rateLimit(bucketKey, limit, windowMs) {
  const now = Date.now();
  if (rate.size > RATE_MAP_MAX) {
    for (const [k, v] of rate) if (now > v.reset) rate.delete(k);
    if (rate.size > RATE_MAP_MAX) rate.clear();
  }
  let e = rate.get(bucketKey);
  if (!e || now > e.reset) {
    e = { n: 0, reset: now + windowMs };
    rate.set(bucketKey, e);
  }
  e.n += 1;
  return e.n <= limit;
}

export const handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: isOriginAllowed(origin) ? 204 : 403, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }
  if (!isOriginAllowed(origin)) {
    return {
      statusCode: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Forbidden' }),
    };
  }

  const ip =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';
  if (!rateLimit(ip, 60, 600000)) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Content-Type': 'application/json', 'Retry-After': '600' },
      body: JSON.stringify({ ok: false, error: 'Too many attempts. Try again later.' }),
    };
  }

  let body = {};
  try {
    const raw =
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body || '{}';
    body = JSON.parse(raw);
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid JSON' }),
    };
  }

  const code = String(body.code || '')
    .toLowerCase()
    .trim();
  const codes = portalCodes();
  const ok = code && codes.includes(code);

  return {
    statusCode: ok ? 200 : 401,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(ok ? { ok: true } : { ok: false, error: 'Invalid word of power' }),
  };
};
