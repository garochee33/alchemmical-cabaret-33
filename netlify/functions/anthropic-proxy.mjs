/**
 * Anthropic Messages API proxy — keeps ANTHROPIC_API_KEY on the server.
 * Netlify: Site settings → Environment variables → ANTHROPIC_API_KEY
 */
export const handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
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

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: rawBody,
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
