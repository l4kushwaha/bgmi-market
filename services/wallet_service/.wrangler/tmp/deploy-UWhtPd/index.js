var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-XSS-Protection": "1; mode=block",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
};
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  ...securityHeaders
};
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
__name(base64UrlDecode, "base64UrlDecode");
async function verifyJwt(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(parts[2]), data);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (payload.exp && payload.exp * 1e3 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
__name(verifyJwt, "verifyJwt");
var index_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    const json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    }), "json");
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const db = env.bgmi_db;
      const authUser = /* @__PURE__ */ __name(async () => {
        const h = req.headers.get("Authorization");
        if (!h || !h.startsWith("Bearer ")) return null;
        return verifyJwt(h.slice(7), env.JWT_SECRET);
      }, "authUser");
      const adminOnly = /* @__PURE__ */ __name(async () => {
        const u = await authUser();
        if (!u || u.role !== "admin") return null;
        return u;
      }, "adminOnly");
      const MARKETPLACE_URL = env.MARKETPLACE_URL || "https://bgmi_marketplace_service.bgmi-gateway.workers.dev";
      async function marketplaceListing(orderId) {
        try {
          const n = String(orderId || "").replace(/[^0-9]/g, "").slice(0, 12);
          if (!/^[0-9]+$/.test(n)) return null;
          const res = await fetch(`${MARKETPLACE_URL}/api/listings/${n}`);
          if (!res.ok) return null;
          return await res.json();
        } catch (e) {
          console.error("marketplaceListing error", e && e.message);
          return null;
        }
      }
      __name(marketplaceListing, "marketplaceListing");
      async function rateLimited(userId, seconds, max) {
        try {
          const row = await db.prepare(
            `SELECT COUNT(*) AS c FROM service_payments
             WHERE buyer_id=? AND created_at > datetime('now','-${Math.floor(seconds)} seconds')`
          ).bind(String(userId)).first();
          return Number(row?.c || 0) >= max;
        } catch {
          return false;
        }
      }
      __name(rateLimited, "rateLimited");
      async function platformSetting(key) {
        try {
          const row = await db.prepare(
            "SELECT value FROM settings WHERE key=?"
          ).bind(key).first();
          if (row && row.value) return String(row.value);
        } catch {
        }
        return null;
      }
      __name(platformSetting, "platformSetting");
      async function platformUpi() {
        const dbUpI = await platformSetting("admin_upi_id");
        const dbName = await platformSetting("admin_upi_name");
        return {
          admin_upi_id: dbUpI || env.ADMIN_UPI_ID || "pay@bgmimarket",
          admin_upi_name: dbName || env.ADMIN_UPI_NAME || "BGMI Market"
        };
      }
      __name(platformUpi, "platformUpi");
      if (path === "/health" || path === "/") {
        return json({ service: "wallet", version: "2.0.0", status: "running" });
      }
      if (path === "/pay/service-charge" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const buyer_id = String(body.buyer_id || user.id);
        const { order_id, seller_id, amount } = body;
        const purpose = body.purpose === "half" ? "half" : "full";
        if (!order_id || !seller_id || !amount) {
          return json({ error: "missing_fields" }, 400);
        }
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt < 1 || amt > 1e7) {
          return json({ error: "invalid_amount" }, 400);
        }
        if (String(order_id).length > 64 || !/^[A-Za-z0-9_-]+$/.test(String(order_id))) {
          return json({ error: "invalid_order_id" }, 400);
        }
        if (buyer_id !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        if (await rateLimited(user.id, 60, 5)) {
          return json({ error: "too_many_requests", message: "Too many payment attempts. Try later." }, 429);
        }
        const listing = await marketplaceListing(order_id);
        if (!listing) {
          return json({ error: "invalid_order", message: "Order (listing) not found" }, 400);
        }
        if (String(listing.seller_id) !== String(seller_id)) {
          return json({ error: "seller_mismatch", message: "Seller does not match this order" }, 400);
        }
        if (purpose === "full") {
          if (amt !== Number(listing.price)) {
            return json({ error: "amount_mismatch", message: `Amount must match the listing price (\u20B9${Number(listing.price).toLocaleString("en-IN")})` }, 400);
          }
        } else if (amt > Number(listing.price)) {
          return json({ error: "amount_too_high", message: "Amount cannot exceed the listing price" }, 400);
        }
        const existing = await db.prepare(`
          SELECT * FROM service_payments
          WHERE order_id=? AND status IN ('awaiting_confirmation','submitted','paid','released')
        `).bind(order_id).first();
        if (existing) {
          const { admin_upi_id: adminUpi, admin_upi_name: adminUpiName2 } = await platformUpi();
          return json({
            message: "Payment already created",
            payment_id: existing.id,
            order_id: existing.order_id,
            upi_id: existing.payee_upi || adminUpi,
            upi_name: existing.payee_name || adminUpiName2,
            upi_amount: existing.total_amount,
            status: existing.status,
            utr: existing.utr || null,
            purpose: existing.purpose || "full",
            direct_to_seller: !!existing.payee_upi && existing.payee_upi !== adminUpi
          });
        }
        const admin_fee = Math.floor(Number(amount) * 0.1);
        const seller_amount = Number(amount) - admin_fee;
        const { admin_upi_id: adminUpiId, admin_upi_name: adminUpiName } = await platformUpi();
        let payee_upi = adminUpiId;
        let payee_name = adminUpiName;
        let payee_is_seller = false;
        const verifyBase = env.VERIFY_URL || "https://verification_service.bgmi-gateway.workers.dev";
        try {
          const sellerReq = new Request(`${verifyBase}/seller/upi/${String(seller_id).replace(/[^0-9]/g, "")}`, {
            headers: { Authorization: req.headers.get("Authorization") || "" }
          });
          const sellerRes = env.VERIFICATION_SERVICE ? await env.VERIFICATION_SERVICE.fetch(sellerReq) : await fetch(sellerReq);
          if (sellerRes.ok) {
            const sellerInfo = await sellerRes.json();
            if (sellerInfo.has_upi && sellerInfo.upi_id) {
              payee_upi = sellerInfo.upi_id;
              payee_name = sellerInfo.upi_name || "Seller";
              payee_is_seller = true;
            }
          }
        } catch (e) {
        }
        const payment_id = crypto.randomUUID();
        await db.prepare(`
          INSERT INTO service_payments
          (id, order_id, buyer_id, seller_id, total_amount,
           admin_fee, seller_amount, status, utr, payee_upi, payee_name, purpose)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', NULL, ?, ?, ?)
        `).bind(
          payment_id,
          order_id,
          buyer_id,
          seller_id,
          Number(amount),
          admin_fee,
          seller_amount,
          payee_upi,
          payee_name,
          purpose
        ).run();
        return json({
          payment_id,
          order_id,
          upi_id: payee_upi,
          upi_name: payee_name,
          upi_amount: Number(amount),
          total_amount: Number(amount),
          status: "awaiting_confirmation",
          purpose,
          direct_to_seller: payee_is_seller,
          note: payee_is_seller ? "Pay the full amount directly to the seller's UPI ID, then submit your UTR / reference number." : "Seller has not set a UPI ID yet. Pay to the platform UPI ID, then submit your UTR / reference number."
        });
      }
      if (path === "/pay/submit" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const { order_id, utr } = body;
        if (!order_id || !utr) return json({ error: "missing_order_id_or_utr" }, 400);
        if (await rateLimited(user.id, 60, 5)) {
          return json({ error: "too_many_requests", message: "Too many submissions. Try later." }, 429);
        }
        const pay = await db.prepare(`
          SELECT * FROM service_payments WHERE order_id=? AND status='awaiting_confirmation'
        `).bind(order_id).first();
        if (!pay) return json({ error: "payment_not_found" }, 404);
        if (String(pay.buyer_id) !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        const cleanUtr = String(utr || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
        if (cleanUtr.length < 6) return json({ error: "invalid_utr" }, 400);
        const dup = await db.prepare(`
          SELECT id FROM service_payments
          WHERE utr=? AND status IN ('submitted','paid','released')
        `).bind(cleanUtr).first();
        if (dup) {
          return json({ error: "utr_already_used", message: "This UTR has already been used for another payment" }, 409);
        }
        await db.prepare(`
          UPDATE service_payments SET status='submitted', utr=? WHERE order_id=?
        `).bind(cleanUtr, order_id).run();
        return json({ message: "Payment submitted for verification", status: "submitted" });
      }
      if (path === "/pay/release" && method === "POST") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const body = await req.json();
        const { order_id } = body;
        if (!order_id) return json({ error: "missing_order_id" }, 400);
        const pay = await db.prepare(`
          SELECT * FROM service_payments WHERE order_id=?
        `).bind(order_id).first();
        if (!pay) return json({ error: "payment_not_found" }, 404);
        if (pay.status === "released") return json({ error: "already_released" }, 409);
        if (pay.status !== "submitted" && pay.status !== "paid") {
          return json({ error: "payment_not_confirmed", message: "Buyer must submit UTR first (status: " + pay.status + ")" }, 409);
        }
        const existing = await db.prepare(`
          SELECT id FROM seller_earnings WHERE order_id=? AND status='released'
        `).bind(order_id).first();
        if (existing) return json({ error: "already_released" }, 409);
        await db.prepare(`
          UPDATE service_payments SET status='released' WHERE order_id=?
        `).bind(order_id).run();
        await db.prepare(`
          INSERT INTO seller_earnings (seller_id, order_id, amount, status)
          VALUES (?, ?, ?, 'released')
        `).bind(pay.seller_id, order_id, pay.seller_amount).run();
        return json({
          message: "Payment confirmed & escrow released",
          seller_id: pay.seller_id,
          seller_amount: pay.seller_amount
        });
      }
      if (path === "/balance" && method === "GET") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);
        const released = await db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS total FROM seller_earnings
          WHERE seller_id=? AND status='released'
        `).bind(String(user.id)).first();
        const held = await db.prepare(`
          SELECT COALESCE(SUM(seller_amount),0) AS total FROM service_payments
          WHERE seller_id=? AND status='paid'
        `).bind(String(user.id)).first();
        const withdrawn = await db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS total FROM withdraw_requests
          WHERE seller_id=? AND status IN ('pending','processed')
        `).bind(String(user.id)).first();
        const available = Math.max(0, (released?.total || 0) - (withdrawn?.total || 0));
        return json({
          available_balance: Number(available.toFixed(2)),
          escrow_held: Number(held?.total || 0),
          total_withdrawn: Number(withdrawn?.total || 0)
        });
      }
      if (path === "/withdraw" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const amount = Number(body.amount);
        const upi_id = body.upi_id;
        if (!Number.isFinite(amount) || amount < 10 || amount > 1e7) {
          return json({ error: "invalid_amount (min \u20B910, max \u20B910,000,000)" }, 400);
        }
        if (!upi_id || !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi_id)) {
          return json({ error: "invalid_upi" }, 400);
        }
        if (String(upi_id).length > 60) return json({ error: "invalid_upi" }, 400);
        const bal = await db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS total FROM seller_earnings
          WHERE seller_id=? AND status='released'
        `).bind(String(user.id)).first();
        const wd = await db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS total FROM withdraw_requests
          WHERE seller_id=? AND status IN ('pending','processed')
        `).bind(String(user.id)).first();
        const available = (bal?.total || 0) - (wd?.total || 0);
        if (amount > available) return json({ error: "insufficient_balance" }, 400);
        await db.prepare(`
          INSERT INTO withdraw_requests (seller_id, amount, upi_id, status, created_at)
          VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        `).bind(String(user.id), amount, upi_id).run();
        return json({ message: "Withdrawal requested", amount });
      }
      if (path === "/withdrawals" && method === "GET") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);
        const { results } = await db.prepare(`
          SELECT * FROM withdraw_requests
          WHERE seller_id=? ORDER BY created_at DESC
        `).bind(String(user.id)).all();
        return json(results || []);
      }
      if (path === "/admin/earnings" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const total = await db.prepare(`
          SELECT COALESCE(SUM(admin_fee),0) AS total FROM service_payments WHERE status='paid'
        `).first();
        const paid = await db.prepare(`
          SELECT COALESCE(SUM(total_amount),0) AS total FROM service_payments WHERE status='paid'
        `).first();
        const pending = await db.prepare(`
          SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS total
          FROM service_payments WHERE status='created'
        `).first();
        const released = await db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS total FROM seller_earnings WHERE status='released'
        `).first();
        const withdraw = await db.prepare(`
          SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total
          FROM withdraw_requests WHERE status='pending'
        `).first();
        return json({
          total_admin_fees: total?.total || 0,
          total_volume: paid?.total || 0,
          total_released: released?.total || 0,
          pending_payments: pending?.c || 0,
          pending_amount: pending?.total || 0,
          pending_withdrawals: withdraw?.c || 0,
          pending_withdrawal_amount: withdraw?.total || 0
        });
      }
      if (path === "/admin/payments" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const { results } = await db.prepare(`
          SELECT * FROM service_payments ORDER BY created_at DESC LIMIT 200
        `).all();
        return json(results || []);
      }
      if (path === "/admin/withdrawals" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const status = url.searchParams.get("status") || "";
        const { results } = status ? await db.prepare(`SELECT * FROM withdraw_requests WHERE status=? ORDER BY created_at DESC LIMIT 200`).bind(status).all() : await db.prepare(`SELECT * FROM withdraw_requests ORDER BY created_at DESC LIMIT 200`).all();
        return json(results || []);
      }
      if (path.startsWith("/admin/withdrawals/") && method === "POST") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const parts = path.split("/");
        const id = Number(parts[3]);
        const action = parts[4];
        if (!id || !["process", "reject"].includes(action)) {
          return json({ error: "invalid_request" }, 400);
        }
        const wd = await db.prepare(`SELECT * FROM withdraw_requests WHERE id=?`).bind(id).first();
        if (!wd) return json({ error: "withdraw_request_not_found" }, 404);
        if (wd.status !== "pending") return json({ error: "already_processed" }, 409);
        const newStatus = action === "process" ? "processed" : "rejected";
        await db.prepare(`UPDATE withdraw_requests SET status=? WHERE id=?`).bind(newStatus, id).run();
        return json({
          message: `Withdrawal ${newStatus}`,
          id: wd.id,
          seller_id: wd.seller_id,
          amount: wd.amount,
          status: newStatus
        });
      }
      if (path === "/admin/balances" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const { results } = await db.prepare(`
          SELECT seller_id,
                 COALESCE(SUM(CASE WHEN status='released' THEN amount ELSE 0 END),0) AS released,
                 COALESCE(SUM(CASE WHEN status='held' THEN amount ELSE 0 END),0) AS held,
                 COUNT(CASE WHEN status='released' THEN 1 END) AS payouts
          FROM seller_earnings GROUP BY seller_id ORDER BY released DESC LIMIT 100
        `).all();
        return json(results || []);
      }
      if (path === "/admin/settings" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const { admin_upi_id, admin_upi_name } = await platformUpi();
        return json({ admin_upi_id, admin_upi_name });
      }
      if (path === "/admin/settings" && method === "PUT") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);
        const body = await req.json().catch(() => ({}));
        const upi_id = String(body.admin_upi_id || "").trim();
        const upi_name = String(body.admin_upi_name || "").trim();
        if (upi_id && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi_id)) {
          return json({ error: "invalid_upi_id", message: "UPI ID must look like name@bank" }, 400);
        }
        if (upi_id.length > 60 || upi_name.length > 60) {
          return json({ error: "too_long", message: "Max 60 characters" }, 400);
        }
        for (const [key, value] of [["admin_upi_id", upi_id], ["admin_upi_name", upi_name]]) {
          await db.prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
          ).bind(key, value).run();
        }
        const { admin_upi_id: savedId, admin_upi_name: savedName } = await platformUpi();
        return json({ message: "Settings saved", admin_upi_id: savedId, admin_upi_name: savedName });
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "server_error", message: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
