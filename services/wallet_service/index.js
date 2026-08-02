/**
 * =====================================================
 * 💰 BGMI Wallet Service v2.0.0
 * =====================================================
 * ✅ JWT auth everywhere (standalone HS256 verifier, no deps)
 * ✅ Service-charge payment via Razorpay (10% admin fee)
 * ✅ Payment verification (signature check)
 * ✅ Escrow release to seller (admin)
 * ✅ Seller balance + withdraw requests
 * ✅ Protected admin earnings report
 * =====================================================
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const db = env.bgmi_db;

      const authUser = async () => {
        const h = req.headers.get("Authorization");
        if (!h || !h.startsWith("Bearer ")) return null;
        return verifyJwt(h.slice(7), env.JWT_SECRET);
      };

      const adminOnly = async () => {
        const u = await authUser();
        if (!u || u.role !== "admin") return null;
        return u;
      };

      if (path === "/health" || path === "/") {
        return json({ service: "wallet", version: "2.0.0", status: "running" });
      }

      /* ==============================================
         SERVICE CHARGE PAYMENT (10% admin fee)
         ============================================== */
      if (path === "/pay/service-charge" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        const buyer_id = String(body.buyer_id || user.id);
        const { order_id, seller_id, amount } = body;

        if (!order_id || !seller_id || !amount) {
          return json({ error: "missing_fields" }, 400);
        }
        if (buyer_id !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }

        const existing = await db.prepare(`
          SELECT id FROM service_payments
          WHERE order_id=? AND status='paid'
        `).bind(order_id).first();

        if (existing) {
          return json({ error: "service_charge_already_paid" }, 409);
        }

        const admin_fee = Math.floor(Number(amount) * 0.10);
        const seller_amount = Number(amount) - admin_fee;

        const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: admin_fee * 100,
            currency: "INR",
            receipt: "svc_" + order_id
          })
        });

        if (!rpRes.ok) {
          const e = await rpRes.text();
          throw new Error("Razorpay order failed: " + e);
        }

        const rpOrder = await rpRes.json();
        const payment_id = crypto.randomUUID();

        await db.prepare(`
          INSERT INTO service_payments
          (id, order_id, buyer_id, seller_id, total_amount,
           admin_fee, seller_amount, razorpay_order_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created')
        `).bind(
          payment_id,
          order_id,
          buyer_id,
          seller_id,
          Number(amount),
          admin_fee,
          seller_amount,
          rpOrder.id
        ).run();

        return json({
          razorpay_order_id: rpOrder.id,
          razorpay_key: env.RAZORPAY_KEY_ID,
          admin_fee,
          seller_amount
        });
      }

      /* ==============================================
         VERIFY PAYMENT (Razorpay callback)
         ============================================== */
      if (path === "/pay/verify" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
          return json({ error: "missing_fields" }, 400);
        }

        const enc = new TextEncoder();
        const data = `${razorpay_order_id}|${razorpay_payment_id}`;
        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(env.RAZORPAY_KEY_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data));
        const expectedSig = Array.from(new Uint8Array(sigBuf))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");

        if (expectedSig !== razorpay_signature) {
          return json({ error: "invalid_signature" }, 400);
        }

        await db.prepare(`
          UPDATE service_payments
          SET status='paid',
              razorpay_payment_id=?,
              paid_at=CURRENT_TIMESTAMP
          WHERE razorpay_order_id=?
        `).bind(razorpay_payment_id, razorpay_order_id).run();

        return json({ success: true });
      }

      /* ==============================================
         RELEASE ESCROW TO SELLER (admin)
         ============================================== */
      if (path === "/pay/release" && method === "POST") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);

        const body = await req.json();
        const { order_id } = body;
        if (!order_id) return json({ error: "missing_order_id" }, 400);

        const pay = await db.prepare(`
          SELECT * FROM service_payments WHERE order_id=? AND status='paid'
        `).bind(order_id).first();

        if (!pay) return json({ error: "payment_not_found" }, 404);

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
          message: "Escrow released",
          seller_id: pay.seller_id,
          seller_amount: pay.seller_amount
        });
      }

      /* ==============================================
         SELLER BALANCE
         ============================================== */
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

      /* ==============================================
         SELLER WITHDRAWAL REQUEST
         ============================================== */
      if (path === "/withdraw" && method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        const amount = Number(body.amount);
        const upi_id = body.upi_id;

        if (!amount || amount <= 0) return json({ error: "invalid_amount" }, 400);
        if (!upi_id || !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi_id)) {
          return json({ error: "invalid_upi" }, 400);
        }

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

      /* ==============================================
         MY WITHDRAWALS
         ============================================== */
      if (path === "/withdrawals" && method === "GET") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const { results } = await db.prepare(`
          SELECT * FROM withdraw_requests
          WHERE seller_id=? ORDER BY created_at DESC
        `).bind(String(user.id)).all();

        return json(results || []);
      }

      /* ==============================================
         ADMIN: EARNINGS REPORT
         ============================================== */
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

      /* ==============================================
         ADMIN: ALL PAYMENTS
         ============================================== */
      if (path === "/admin/payments" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);

        const { results } = await db.prepare(`
          SELECT * FROM service_payments ORDER BY created_at DESC LIMIT 200
        `).all();

        return json(results || []);
      }

      /* ==============================================
         ADMIN: WITHDRAWAL QUEUE
         ============================================== */
      if (path === "/admin/withdrawals" && method === "GET") {
        const admin = await adminOnly();
        if (!admin) return json({ error: "admin_only" }, 403);

        const status = url.searchParams.get("status") || "";
        const { results } = status
          ? await db.prepare(`SELECT * FROM withdraw_requests WHERE status=? ORDER BY created_at DESC LIMIT 200`).bind(status).all()
          : await db.prepare(`SELECT * FROM withdraw_requests ORDER BY created_at DESC LIMIT 200`).all();

        return json(results || []);
      }

      /* ==============================================
         ADMIN: PROCESS WITHDRAWAL
         ============================================== */
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
        await db.prepare(`UPDATE withdraw_requests SET status=? WHERE id=?`)
          .bind(newStatus, id).run();

        return json({
          message: `Withdrawal ${newStatus}`,
          id: wd.id,
          seller_id: wd.seller_id,
          amount: wd.amount,
          status: newStatus
        });
      }

      /* ==============================================
         ADMIN: SELLER EARNINGS OVERVIEW
         ============================================== */
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

      return json({ error: "not_found" }, 404);

    } catch (err) {
      return new Response(
        JSON.stringify({ error: "server_error", message: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
