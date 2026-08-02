/**
 * ============================================================
 * 🌐 BGMI Gateway — v2.3.2 (Extended + Fixed Auth Health)
 * ============================================================
 * ✅ Exact CORS for frontend
 * ✅ Fixed auth URL secret (AUTH_URL)
 * ✅ Fully working /api/health & /api/debug
 * ✅ Admin + User login fixed
 * ✅ Correct route order, OPTIONS handling, HTML guard
 * ✅ Retry once on 5xx errors
 * ============================================================
 */

const ALLOWED_ORIGIN = "https://bgmi-frontend.vercel.app"; // Exact allowed frontend

// -----------------------------
// 🧩 Helper: Generate CORS headers
// -----------------------------
function corsHeaders(allowHeaders = "Content-Type, Authorization") {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "Content-Length, Content-Type",
  };
}

// -----------------------------
// 🌐 Build service URLs
// -----------------------------
function buildServiceUrls(env) {
  return {
    auth: env.AUTH_SERVICE_URL ?? "https://auth-service.bgmi-gateway.workers.dev",
    market: env.MARKET_SERVICE_URL ?? "https://bgmi_marketplace_service.bgmi-gateway.workers.dev",
    wallet: env.WALLET_SERVICE_URL ?? "https://bgmi-marketplace.bgmi-gateway.workers.dev",
    verify: env.VERIFY_SERVICE_URL ?? "https://verification_service.bgmi-gateway.workers.dev",
    chat: env.CHAT_SERVICE_URL ?? "https://bgmi_chat_service.bgmi-gateway.workers.dev",
    admin: env.ADMIN_SERVICE_URL ?? "https://bgmi-marketplace.bgmi-gateway.workers.dev",
    notification: env.NOTIFY_SERVICE_URL ?? "https://bgmi_chat_service.bgmi-gateway.workers.dev",
  };
}

// -----------------------------
// 🔁 Proxy forward with retry
// -----------------------------
async function fetchWithForward(request, targetUrl) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    init.body = await request.arrayBuffer().catch(() => null);
  }

  try {
    const resp = await fetch(targetUrl, init);
    if (!resp.ok && resp.status >= 500) {
      // Retry once on 5xx
      try {
        return await fetch(targetUrl, init);
      } catch {
        return resp;
      }
    }
    return resp;
  } catch (e) {
    throw new Error(`Fetch failed: ${e.message}`);
  }
}

// -----------------------------
// 💓 Health checker for all microservices
// -----------------------------
async function serviceHealthCheck(name, url) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { cf: { cacheTtl: 0 } });
    const json = await res.json().catch(() => ({}));
    return { service: name, status: res.ok ? "running" : "down", details: json };
  } catch (e) {
    return { service: name, status: "down", error: e.message };
  }
}

async function allServicesHealth(env) {
  const services = buildServiceUrls(env);
  const results = await Promise.allSettled(
    Object.entries(services).map(([n, u]) => serviceHealthCheck(n, u))
  );
  return Object.fromEntries(
    results.map((r, i) => {
      const name = Object.keys(services)[i];
      return [name, r.status === "fulfilled" ? r.value : { service: name, status: "down", error: "fetch_failed" }];
    })
  );
}

// -----------------------------
// 🚀 Main Fetch Handler
// -----------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = rawPath.replace(/\/+$/, "") || "/";
    const originHeader = request.headers.get("Origin") || "";
    const acHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization";
    const cors = corsHeaders(acHeaders);

    // --- OPTIONS preflight ---
    if (request.method === "OPTIONS") {
      return new Response("OK", { headers: cors });
    }

    // --- Block unapproved origins ---
    if (originHeader && originHeader !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Origin not allowed", origin: originHeader }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Root info ---
    if (path === "/" || path === "/index.html") {
      return new Response(JSON.stringify({ status: "gateway running ✅", time: new Date().toISOString() }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Global health endpoint ---
    if (path.startsWith("/api/health") || path === "/health") {
      const services = await allServicesHealth(env);
      return new Response(JSON.stringify({ gateway: "ok", version: "2.3.2", timestamp: new Date().toISOString(), services }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Debug endpoint ---
    if (path.startsWith("/api/debug")) {
      const services = await allServicesHealth(env);
      return new Response(JSON.stringify({ message: "gateway debug", originReceived: originHeader || null, allowedOrigin: ALLOWED_ORIGIN, version: "2.3.2", services, time: new Date().toISOString() }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Admin login via gateway ---
    if (path === "/api/admin/login" && request.method === "POST") {
      const { email, password } = await request.json().catch(() => ({}));
      const ADMIN_EMAIL = env.ADMIN_EMAIL;
      const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
      if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Admin credentials not configured" }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ message: "Admin login successful", user: { email, role: "admin" } }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Auth service health proxy ---
    if (path.startsWith("/api/auth/health")) {
      const AUTH_URL = env.AUTH_SERVICE_URL ?? "https://auth-service.bgmi-gateway.workers.dev";
      try {
        const resp = await fetch(`${AUTH_URL.replace(/\/+$/, "")}/health`, { cf: { cacheTtl: 0 } });
        const data = await resp.json().catch(() => ({}));
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Auth service unreachable", details: err.message }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    // --- Test endpoint ---
    if (path.startsWith("/api/test-cors")) {
      return new Response(JSON.stringify({ ok: true, allowedOrigin: ALLOWED_ORIGIN, originReceived: originHeader }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // --- Universal Proxy ---
    const match = path.match(/^\/api\/([^\/]+)(\/.*)?/);
    if (match) {
      const service = match[1];
      const restPath = (match[2] || "").replace(/^\//, "");
      const SERVICE_URLS = buildServiceUrls(env);
      const base = SERVICE_URLS[service];

      if (!base) {
        return new Response(JSON.stringify({ error: `Unknown service '${service}'` }), {
          status: 404,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const targetUrl = restPath ? `${base.replace(/\/+$/, "")}/${restPath}${url.search}` : `${base}${url.search}`;

      try {
        const proxied = await fetchWithForward(request, targetUrl);
        const text = await proxied.clone().text().catch(() => "");
        const contentType = proxied.headers.get("content-type") || "";

        // Prevent HTML leak
        if (text.trim().startsWith("<!DOCTYPE") || contentType.includes("text/html")) {
          return new Response(JSON.stringify({ error: "Service returned HTML", service, preview: text.slice(0, 160) }), {
            status: proxied.status,
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        const headers = new Headers(proxied.headers);
        Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

        return new Response(proxied.body, { status: proxied.status, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: `${service} unreachable`, details: err.message }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    // --- Fallback 404 ---
    return new Response(JSON.stringify({ error: "Not Found", path }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
