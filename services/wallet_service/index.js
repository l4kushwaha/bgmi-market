export default {
  async fetch(req, env) {

    /* ================= CORS ================= */
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };

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

      /* ================= HELPERS ================= */
      const uuid = () => crypto.randomUUID();

      /* ======================================================
         CREATE SERVICE CHARGE PAYMENT (10%)
         ====================================================== */
      if (path === "/pay/service-charge" && method === "POST") {
        const body = await req.json();
        const { order_id, buyer_id, seller_id, amount } = body;

        if (!order_id || !buyer_id || !seller_id || !amount) {
          return json({ error: "missing_fields" }, 400);
        }

        // 🔒 Prevent duplicate payment
        const existing = await db.prepare(`
          SELECT id FROM service_payments
          WHERE order_id=? AND status='paid'
        `).bind(order_id).first();

        if (existing) {
          return json({ error: "service_charge_already_paid" }, 409);
        }

        const admin_fee = Math.floor(amount * 0.10);
        const seller_amount = amount - admin_fee;

        /* ================= CREATE RAZORPAY ORDER ================= */
        const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: {
            "Authorization":
              "Basic " +
              btoa(
                env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET
              ),
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
        const payment_id = uuid();

        /* ================= SAVE TO DB ================= */
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
          amount,
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

      /* ======================================================
         VERIFY PAYMENT (Razorpay callback)
         ====================================================== */
      if (path === "/pay/verify" && method === "POST") {
        const body = await req.json();
        const {
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature
        } = body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
          return json({ error: "missing_fields" }, 400);
        }

        /* ================= VERIFY SIGNATURE ================= */
        const enc = new TextEncoder();
        const data = `${razorpay_order_id}|${razorpay_payment_id}`;

        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(env.RAZORPAY_KEY_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );

        const sigBuf = await crypto.subtle.sign(
          "HMAC",
          key,
          enc.encode(data)
        );

        const expectedSig = Array.from(new Uint8Array(sigBuf))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");

        if (expectedSig !== razorpay_signature) {
          return json({ error: "invalid_signature" }, 400);
        }

        /* ================= UPDATE DB ================= */
        await db.prepare(`
          UPDATE service_payments
          SET status='paid',
              razorpay_payment_id=?,
              paid_at=CURRENT_TIMESTAMP
          WHERE razorpay_order_id=?
        `).bind(
          razorpay_payment_id,
          razorpay_order_id
        ).run();

        return json({ success: true });
      }

      /* ======================================================
         ADMIN REPORT (OPTIONAL)
         ====================================================== */
      if (path === "/admin/earnings" && method === "GET") {
        const row = await db.prepare(`
          SELECT SUM(admin_fee) AS total
          FROM service_payments
          WHERE status='paid'
        `).first();

        return json({ total_earnings: row?.total || 0 });
      }

      return json({ error: "not_found" }, 404);

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "server_error",
          message: err.message
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
  }
};
