/**
 * Anthropic Messages API proxy — ANTHROPIC_API_KEY stays on Netlify.
 * Production: origin allowlist, body limits, model allowlist, max_tokens cap, rate limits.
 */

const DEFAULT_ORIGINS = [
  'https://illuminaexperience.com',
  'https://www.illuminaexperience.com',
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
const MAX_TOKENS_CAP = 8192;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = o;
  return h;
}

const rate = new Map();
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  let e = rate.get(ip);
  if (!e || now > e.reset) {
    e = { n: 0, reset: now + windowMs };
    rate.set(ip, e);
  }
  e.n += 1;
  return e.n <= limit;
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

  if (!rateLimit(ip, 50, 600000)) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }),
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
  return {
    statusCode: upstream.status,
    headers: {
      ...cors,
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    },
    body: text,
  };
};
