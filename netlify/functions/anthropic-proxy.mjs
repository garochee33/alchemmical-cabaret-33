/**
 * Anthropic Messages API proxy — ANTHROPIC_API_KEY stays on Netlify.
 * Production: origin allowlist, body limits, model allowlist, max_tokens cap, rate limits.
 */

const DEFAULT_ORIGINS = [
  'https://illuminexperience.com',
  'https://www.illuminexperience.com',
  'https://alchemmical-cabaret-33.netlify.app',
];

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-6',
]);

const MAX_BODY = 280000;
const MAX_MESSAGES = 48;
const MAX_MSG_CHARS = 120000;
const MAX_TOKENS_CAP = 4096;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const RATE_MAP_MAX = 20000;

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : DEFAULT_ORIGINS;
}

function isOriginAllowed(origin) {
  const o = (origin || '').trim();
  if (process.env.NETLIFY_DEV === 'true' && /^http:\/\/localhost:\d+$/.test(o)) return true;
  if (!o) return false;
  const list = parseAllowedOrigins();
  if (list.includes(o)) return true;
  try {
    if (new URL(o).hostname.endsWith('.netlify.app')) return true;
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

function bucketFor(event, ip) {
  const sid = String(
    event.headers['x-trinity-session'] || event.headers['X-Trinity-Session'] || '',
  )
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  return sid ? `${ip}|${sid}` : ip;
}

function sanitizePayload(parsed) {
  const modelIn = String(parsed.model || '').trim();
  const model = ALLOWED_MODELS.has(modelIn) ? modelIn : DEFAULT_MODEL;

  let max_tokens = Number(parsed.max_tokens);
  if (!Number.isFinite(max_tokens) || max_tokens < 1) max_tokens = 1024;
  max_tokens = Math.min(Math.floor(max_tokens), MAX_TOKENS_CAP);

  const system =
    typeof parsed.system === 'string'
      ? parsed.system.slice(0, 500000)
      : parsed.system != null
        ? JSON.stringify(parsed.system).slice(0, 500000)
        : undefined;

  const messagesIn = Array.isArray(parsed.messages) ? parsed.messages : [];
  const messages = [];
  for (let i = 0; i < Math.min(messagesIn.length, MAX_MESSAGES); i++) {
    const m = messagesIn[i];
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = m.content;
    if (typeof content !== 'string') content = content == null ? '' : JSON.stringify(content);
    content = String(content).slice(0, MAX_MSG_CHARS);
    messages.push({ role, content });
  }

  const out = { model, max_tokens, messages };
  if (system !== undefined) out.system = system;
  return out;
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
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!isOriginAllowed(origin)) {
    return {
      statusCode: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Forbidden' }),
    };
  }

  const ip =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';

  const rlLimit = Math.min(
    500,
    Math.max(10, Number(process.env.ANTHROPIC_RL_LIMIT || 50) || 50),
  );
  const rlWindow = Math.min(
    3_600_000,
    Math.max(60_000, Number(process.env.ANTHROPIC_RL_WINDOW_MS || 600000) || 600000),
  );

  if (!rateLimit(bucketFor(event, ip), rlLimit, rlWindow)) {
    return {
      statusCode: 429,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(rlWindow / 1000)),
      },
      body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }),
    };
  }

  const ipCeil = Math.min(
    50000,
    Math.max(rlLimit, Number(process.env.ANTHROPIC_IP_CEIL || rlLimit * 50) || rlLimit * 50),
  );
  if (!rateLimit(`ip:${ip}`, ipCeil, rlWindow)) {
    return {
      statusCode: 429,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(rlWindow / 1000)),
      },
      body: JSON.stringify({ error: 'Traffic from this network is temporarily throttled.' }),
    };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables.',
      }),
    };
  }

  const rawBody =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body || '';

  if (rawBody.length > MAX_BODY) {
    return {
      statusCode: 413,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Request body too large' }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const safe = sanitizePayload(parsed);
  if (!safe.messages.length) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'messages[] is required' }),
    };
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(safe),
  });

  const text = await upstream.text();
  const outHeaders = {
    ...cors,
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  };
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) outHeaders['Retry-After'] = retryAfter;
  return {
    statusCode: upstream.status,
    headers: outHeaders,
    body: text,
  };
};
