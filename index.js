const express = require('express');
const { Readable } = require('stream');
const { SocksProxyAgent } = require('socks-proxy-agent');

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const app = express();

app.disable('x-powered-by');
app.use(
  express.raw({
    type: '*/*',
    limit: process.env.BODY_LIMIT || '25mb',
  }),
);

const sanitizeUserAgent = (ua) => {
  if (!ua) return DEFAULT_UA;
  const lowered = ua.toLowerCase();
  if (lowered.includes('node') || lowered.includes('curl') || lowered.includes('httpclient')) {
    return DEFAULT_UA;
  }
  return ua;
};

const ensureConfig = () => {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl) {
    throw new Error('Missing ANTHROPIC_BASE_URL environment variable.');
  }

  return { baseUrl, defaultAuthToken: authToken };
};

let cachedFetch;
const getFetch = async () => {
  if (!cachedFetch) {
    cachedFetch = import('node-fetch').then(({ default: nodeFetch }) => nodeFetch);
  }
  return cachedFetch;
};

let cachedProxyAgent;
const getProxyAgent = () => {
  if (process.env.RESIDENTIAL_PROXY_ENABLED === 'false') {
    return undefined;
  }
  if (!cachedProxyAgent) {
    const proxyUrl =
      process.env.RESIDENTIAL_PROXY_URL ||
      [
        'socks5://',
        encodeURIComponent(process.env.RESIDENTIAL_PROXY_USERNAME || 'qGaKikz1Bv'),
        ':',
        encodeURIComponent(process.env.RESIDENTIAL_PROXY_PASSWORD || '4RJVzfTJE3'),
        '@',
        process.env.RESIDENTIAL_PROXY_HOST || 'ca.a0b.com',
        ':',
        process.env.RESIDENTIAL_PROXY_PORT || '10403',
      ].join('');

    cachedProxyAgent = new SocksProxyAgent(proxyUrl);
  }
  return cachedProxyAgent;
};

const pipeWebStream = (webStream, writable) => {
  if (!webStream) {
    writable.end();
    return;
  }

  if (typeof Readable.fromWeb === 'function') {
    Readable.fromWeb(webStream).pipe(writable);
    return;
  }

  const reader = webStream.getReader();
  const read = () =>
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          writable.end();
          return;
        }
        const chunk = Buffer.from(value);
        if (!writable.write(chunk)) {
          writable.once('drain', read);
        } else {
          read();
        }
      })
      .catch((error) => {
        writable.destroy(error);
      });
  read();
};

const firstHeaderValue = (value) => {
  if (Array.isArray(value)) {
    return value.find(Boolean);
  }
  return value;
};

app.use(async (req, res) => {
  let config;
  try {
    config = ensureConfig();
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const targetUrl = new URL(req.originalUrl, config.baseUrl);
  console.log('req.headers is >>>', req.headers);

  const providedApiKey = firstHeaderValue(req.headers['x-api-key']);
  const providedAuthorization = firstHeaderValue(req.headers.authorization);

  let authToken = typeof providedApiKey === 'string' ? providedApiKey.trim() : undefined;

  if (!authToken && typeof providedAuthorization === 'string') {
    const match = providedAuthorization.match(/^Bearer\s+(.+)$/i);
    if (match) {
      authToken = match[1].trim();
    }
  }

  if (!authToken) {
    authToken = config.defaultAuthToken;
  }

  if (!authToken) {
    res.status(401).json({ error: 'Missing Anthropic API token.' });
    return;
  }

  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey === 'connection' || lowerKey === 'content-length') {
      continue;
    }
    if (
      lowerKey === 'authorization' ||
      lowerKey === 'x-api-key' ||
      lowerKey.startsWith('x-forwarded-') ||
      lowerKey === 'via'
    ) {
      continue;
    }
    if (lowerKey === 'user-agent') {
      continue;
    }
    forwardHeaders[key] = value;
  }

  forwardHeaders['user-agent'] = sanitizeUserAgent(req.headers['user-agent']);
  console.log('authToken is >>>', authToken);
  forwardHeaders['x-api-key'] = authToken;
  forwardHeaders['accept-encoding'] = 'identity';

  const requestInit = {
    method: req.method,
    headers: forwardHeaders,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    requestInit.body = req.body;
  }

  try {
    const fetchImpl = await getFetch();
    const proxyAgent = getProxyAgent();
    if (proxyAgent) {
      requestInit.agent = proxyAgent;
    }

    const upstream = await fetchImpl(targetUrl, requestInit);
    console.log('upstream is >>>', upstream);

    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'transfer-encoding' || lowerKey === 'content-length') {
        return;
      }
      res.setHeader(key, value);
    });

    if (req.method.toUpperCase() === 'HEAD') {
      res.end();
      return;
    }

    const onError = (error) => {
      console.error('Stream error from upstream:', error);
      if (!res.headersSent) {
        res.status(502);
      }
      res.end();
    };

    if (!upstream.body) {
      res.end();
      return;
    }

    if (typeof upstream.body.on === 'function') {
      upstream.body.on('error', onError);
      upstream.body.pipe(res);
      return;
    }

    try {
      pipeWebStream(upstream.body, res);
    } catch (error) {
      onError(error);
    }
  } catch (error) {
    console.error('Proxy request failed:', error);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream request failed.' });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Claude code proxy listening on port ${PORT}`);
});
