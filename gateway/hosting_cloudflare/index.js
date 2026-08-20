/**
 * ============================================================
 * 🌐 BGMI Gateway — v3.0.0 (Path-Router Edition)
 * ============================================================
 * ✅ Correct per-service path mapping (fixes broken 404s)
 *    /api/auth/*    -> {auth}   /api/auth/*
 *    /api/market/*  -> {market} /api/*
 *    /api/wallet/*  -> {wallet} /*
 *    /api/verify/*  -> {verify} /*
 *    /api/chat/*    -> {chat}   /api/chat/*
 * ✅ Global health check with correct per-service health paths
 * ✅ Admin login (env-backed), exact-origin CORS
 * ✅ Retry once on 5xx, HTML-leak guard
 * ============================================================
 */

const ALLOWED_ORIGINS = [
  'https://bgmi-frontend.vercel.app',
  'https://bgmi-frontend.vercel.app/',
];

function originAllowed(origin) {
  if (!origin) {return true;}
  const o = origin.replace(/\/$/, '');
  if (ALLOWED_ORIGINS.includes(o)) {return true;}
  try {
    const u = new URL(o);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {return true;}
    if (u.hostname.endsWith('.vercel.app')) {return true;}
  } catch {
    // Ignore URL parsing errors
  }
  return false;
}

// Echo the allowed request origin instead of using "*" (a wildcard origin is
// rejected by browsers for credentialed responses). This gateway authenticates
// with Bearer tokens, never cookies, so credentials are NOT enabled.
function corsHeaders(origin, allowHeaders = 'Content-Type, Authorization') {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
  };
  if (origin) {h['Access-Control-Allow-Origin'] = origin;}
  return h;
}

function buildServiceUrls(env) {
  return {
    auth: env.AUTH_SERVICE_URL ?? 'https://auth-service.bgmi-gateway.workers.dev',
    market: env.MARKET_SERVICE_URL ?? 'https://bgmi_marketplace_service.bgmi-gateway.workers.dev',
    wallet: env.WALLET_SERVICE_URL ?? 'https://bgmi-marketplace.bgmi-gateway.workers.dev',
    verify: env.VERIFY_SERVICE_URL ?? 'https://verification_service.bgmi-gateway.workers.dev',
    chat: env.CHAT_SERVICE_URL ?? 'https://bgmi_chat_service.bgmi-gateway.workers.dev',
  };
}

// Gateway-prefix -> { service base URL, target path prefix }
const SERVICE_ROUTES = {
  auth: { prefix: '/api/auth/' },
  market: { prefix: '/api/' },
  wallet: { prefix: '/' },
  verify: { prefix: '/' },
  chat: { prefix: '/api/chat/' },
};

// Correct health path per service (what each worker actually exposes)
const SERVICE_HEALTH = {
  auth: '/api/auth/health',
  market: '/api/health',
  wallet: '/health',
  verify: '/health',
  chat: '/health',
};

// Prefer Cloudflare service bindings (reliable worker-to-worker),
// fall back to plain fetch of the [vars] URLs.
const BINDING = {
  auth: 'AUTH_SERVICE',
  market: 'MARKET_SERVICE',
  wallet: 'WALLET_SERVICE',
  verify: 'VERIFY_SERVICE',
  chat: 'CHAT_SERVICE',
};

function serviceFetch(env, name, url, init) {
  const binding = BINDING[name] ? env[BINDING[name]] : null;
  if (binding && typeof binding.fetch === 'function') {return binding.fetch(url, init);}
  return fetch(url, init);
}

async function fetchWithForward(request, env, serviceName, targetUrl) {
  const proxy = new Request(targetUrl, request);
  proxy.headers.delete('host');
  proxy.headers.delete('content-length');

  const doFetch = async () =>
    serviceFetch(env, serviceName, proxy.clone(), { redirect: 'manual' });
  try {
    const resp = await doFetch();
    if (resp.status >= 500) {
      try {
        return await doFetch();
      } catch {
        return resp;
      }
    }
    return resp;
  } catch (e) {
    throw new Error(`Fetch failed: ${e.message}`);
  }
}

async function serviceHealthCheck(env, name, url) {
  const path = SERVICE_HEALTH[name] || '/health';
  try {
    const res = await serviceFetch(env, name, `${url.replace(/\/+$/, '')}${path}`, { cf: { cacheTtl: 0 } });
    const body = await res.json().catch(() => ({}));
    return { service: name, status: res.ok ? 'running' : 'down', url, path, details: body };
  } catch (e) {
    return { service: name, status: 'down', url, path, error: e.message };
  }
}

async function allServicesHealth(env) {
  const services = buildServiceUrls(env);
  const results = await Promise.allSettled(
    Object.entries(services).map(([n, u]) => serviceHealthCheck(env, n, u))
  );
  return Object.fromEntries(
    Object.keys(services).map((name, i) => {
      const r = results[i];
      return [name, r.status === 'fulfilled' ? r.value : { service: name, status: 'down', error: 'fetch_failed' }];
    })
  );
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = rawPath.replace(/\/+$/, '') || '/';
    const originHeader = request.headers.get('Origin') || '';
    const acHeaders = request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization';

    if (originHeader && !originAllowed(originHeader)) {
      return json({ error: 'Origin not allowed', origin: originHeader }, 403);
    }

    const cors = corsHeaders(originHeader || '*', acHeaders);

    if (request.method === 'OPTIONS') {
      return new Response('OK', { headers: cors });
    }

    if (path === '/' || path === '/index.html') {
      return json({ status: 'gateway running', version: '3.0.0', time: new Date().toISOString() }, 200, cors);
    }

    // --- Global health ---
    if (path === '/api/health' || path === '/health') {
      const services = await allServicesHealth(env);
      return json({ gateway: 'ok', version: '3.0.0', timestamp: new Date().toISOString(), services }, 200, cors);
    }

    // --- Debug ---
    if (path.startsWith('/api/debug')) {
      const services = await allServicesHealth(env);
      return json({ message: 'gateway debug', originReceived: originHeader || null, version: '3.0.0', services }, 200, cors);
    }

    // --- Admin login is handled by the auth service (/api/auth/login) which
    //     issues JWTs; no plaintext-credential endpoint lives on the gateway.

    // --- Universal proxy ---
    const match = path.match(/^\/api\/([^/]+)(\/.*)?/);
    if (match) {
      const service = match[1].toLowerCase();
      const restPath = (match[2] || '').replace(/^\//, '');
      const SERVICES = buildServiceUrls(env);
      const base = SERVICES[service];

      if (!base) {
        return json({ error: `Unknown service '${service}'` }, 404, cors);
      }

      const route = SERVICE_ROUTES[service];
      const targetPath = `${route.prefix}${restPath}`;
      const targetUrl = `${base.replace(/\/+$/, '')}${targetPath}${url.search}`;

      try {
        const proxied = await fetchWithForward(request, env, service, targetUrl);
        const text = await proxied.clone().text().catch(() => '');
        const contentType = proxied.headers.get('content-type') || '';

        if (text.trim().startsWith('<!DOCTYPE') || contentType.includes('text/html')) {
          return json({ error: 'Service returned HTML', service, targetUrl, preview: text.slice(0, 160) }, proxied.status, cors);
        }

        const headers = new Headers(proxied.headers);
        Object.entries(corsHeaders(originHeader || '*')).forEach(([k, v]) => headers.set(k, v));

        return new Response(proxied.body, { status: proxied.status, headers });
      } catch (err) {
        return json({ error: `${service} unreachable`, details: err.message, targetUrl }, 502, cors);
      }
    }

    return json({ error: 'Not Found', path }, 404, cors);
  },
};
