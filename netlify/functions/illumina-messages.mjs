/**
 * Illumina oracle — Anthropic Messages API proxy (key stays in Netlify env).
 * Same contract as POST /api/experience/illumina-messages on trinity-consortium.
 */
/** Per-edge-instance throttle; limits runaway clients during traffic spikes (not a global quota). */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_POSTS = 48;
const rateBuckets = new Map();

function clientIp(event) {
  const xf = event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || '';
  const first = String(xf).split(',')[0].trim();
  if (first) return first;
  const alt = event.headers['x-nf-client-connection-ip'] || event.headers['X-Nf-Client-Connection-Ip'];
  return (alt && String(alt).trim()) || 'unknown';
}

function rateLimitAllow(ip) {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) rateBuckets.delete(key);
  }
  let entry = rateBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX_POSTS;
}

const ALLOWED_ORIGINS = new Set([
  'https://illuminaexperince.com',
  'https://www.illuminaexperince.com',
  'https://illuminaexperience.com',
  'https://www.illuminaexperience.com',
]);

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
]);

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function isAllowedCaller(origin, referer) {
  const o = (origin || '').trim();
  if (o && ALLOWED_ORIGINS.has(o)) return true;
  const r = (referer || '').trim();
  if (!r) return false;
  try {
    const u = new URL(r);
    return ALLOWED_ORIGINS.has(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  const o = (origin || '').trim();
  const allow = o && ALLOWED_ORIGINS.has(o) ? o : 'https://illuminaexperince.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
}

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Invalid body';
  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) {
    return 'Model not allowed for this portal';
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) {
    return 'Invalid messages';
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Invalid message role';
    if (typeof m.content !== 'string' || m.content.length > 80_000) return 'Invalid message content';
  }
  if (body.system !== undefined && body.system !== null) {
    if (typeof body.system !== 'string' || body.system.length > 120_000) return 'Invalid system';
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const n = body.max_tokens;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20_000) return 'Invalid max_tokens';
  }
  return null;
}

export const handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const referer = event.headers.referer || event.headers.Referer || '';
  const baseHeaders = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: baseHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const ip = clientIp(event);
  if (!rateLimitAllow(ip)) {
    return {
      statusCode: 429,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
        'Retry-After': '45',
      },
      body: JSON.stringify({ error: 'Too many requests; try again shortly' }),
    };
  }

  if (!isAllowedCaller(origin, referer)) {
    return {
      statusCode: 403,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Forbidden' }),
    };
  }

  const apiKey = (process.env.ILLUMINA_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Oracle unavailable' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const validationError = validateBody(body);
  if (validationError) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validationError }),
    };
  }

  const maxTokens = Math.min(Math.max(body.max_tokens ?? 4096, 64), 16_000);

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: maxTokens,
        ...(body.system ? { system: body.system } : {}),
        messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      statusCode: 502,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Oracle upstream error', detail: message }),
    };
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    return {
      statusCode: 502,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Oracle upstream error',
        detail: raw.slice(0, 800),
      }),
    };
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return {
      statusCode: 502,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid upstream response' }),
    };
  }

  const textBlock = Array.isArray(msg.content) ? msg.content.find((b) => b.type === 'text') : null;
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  return {
    statusCode: 200,
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: msg.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: msg.model,
      stop_reason: msg.stop_reason,
      usage: msg.usage,
    }),
  };
};
