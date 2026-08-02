import jwt from "@tsndr/cloudflare-worker-jwt";


export default {
  async fetch(req, env) {

    /* ================= CORS ================= */
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const db = env.chat_db;

      /* ================= HEALTH ================= */
      if (path === "/health" || path === "/api/chat/health") {
        return json({ service: "chat", version: "1.1.1", status: "running" });
      }

      /* ================= HELPERS ================= */
      const uuid = () => crypto.randomUUID();

      async function auth() {
        const h = req.headers.get("Authorization");
        if (!h || !h.startsWith("Bearer ")) return null;

        const token = h.slice(7);
        const valid = await jwt.verify(token, env.JWT_SECRET);
        
        if (!valid) return null;

        const { payload } = jwt.decode(token);
        return payload;
      }

      /* ======================================================
         CREATE CHAT / BUY REQUEST
         ====================================================== */
      if (path === "/api/chat/create" && method === "POST") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        const intent = body.intent === "buy" ? "buy" : "chat";

        if (!body.order_id || !body.seller_user_id) {
          return json({ error: "missing_fields" }, 400);
        }

        const existing = await db.prepare(`
          SELECT id, status, intent
          FROM chat_rooms
          WHERE order_id=?
            AND buyer_id=?
            AND seller_user_id=?
            AND intent=?
            AND status!='closed'
          LIMIT 1
        `).bind(
          String(body.order_id),
          String(user.id),
          String(body.seller_user_id),
          intent
        ).first();

        if (existing) {
          return json({
            room_id: existing.id,
            status: existing.status,
            intent: existing.intent,
            reused: true
          });
        }

        const room_id = uuid();

        await db.prepare(`
          INSERT INTO chat_rooms
          (id, order_id, buyer_id, seller_user_id, status, intent)
          VALUES (?, ?, ?, ?, 'requested', ?)
        `).bind(
          room_id,
          String(body.order_id),
          String(user.id),
          String(body.seller_user_id),
          intent
        ).run();

        return json({
          room_id,
          status: "requested",
          intent,
          reused: false
        });
      }

      /* ======================================================
   GET SINGLE CHAT ROOM
   ====================================================== */
if (path === "/api/chat/room" && method === "GET") {
  const user = await auth();
  if (!user) return json({ error: "unauthorized" }, 401);

  const room_id = url.searchParams.get("room_id");

  const room = await db.prepare(`
    SELECT *
    FROM chat_rooms
    WHERE id=?
  `).bind(room_id).first();

  if (!room) return json({ error: "room_not_found" }, 404);

  if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
    return json({ error: "forbidden" }, 403);
  }

  return json(room);
}


      /* ======================================================
         SELLER APPROVE / REJECT
         ====================================================== */
      if (path === "/api/chat/approve" && method === "POST") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        if (!body.room_id || typeof body.approve !== "boolean") {
          return json({ error: "invalid_payload" }, 400);
        }

        const room = await db.prepare(`
          SELECT status
          FROM chat_rooms
          WHERE id=? AND seller_user_id=?
        `).bind(body.room_id, String(user.id)).first();

        if (!room) return json({ error: "room_not_found" }, 404);
        if (room.status !== "requested")
          return json({ error: "invalid_room_state" }, 409);

        await db.prepare(`
          UPDATE chat_rooms
          SET status=?, approved_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          body.approve ? "approved" : "closed",
          body.room_id
        ).run();

        return json({ status: body.approve ? "approved" : "rejected" });
      }

      /* ======================================================
         HALF PAYMENT DONE (BUYER ONLY)
         ====================================================== */
      if (path === "/api/chat/half-payment" && method === "POST") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();

        const room = await db.prepare(`
          SELECT status
          FROM chat_rooms
          WHERE id=? AND buyer_id=?
        `).bind(body.room_id, String(user.id)).first();

        if (!room) return json({ error: "room_not_found" }, 404);
        if (room.status !== "approved")
          return json({ error: "invalid_state" }, 409);

        await db.prepare(`
          UPDATE chat_rooms
          SET status='half_paid'
          WHERE id=?
        `).bind(body.room_id).run();

        return json({ status: "half_paid" });
      }

      /* ======================================================
         SEND MESSAGE (SECURE)
         ====================================================== */
      if (path === "/api/chat/send" && method === "POST") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const body = await req.json();
        if (!body.room_id || !body.message) {
          return json({ error: "missing_fields" }, 400);
        }

        const room = await db.prepare(`
          SELECT buyer_id, seller_user_id, status
          FROM chat_rooms
          WHERE id=?
        `).bind(body.room_id).first();

        if (!room) return json({ error: "room_not_found" }, 404);

        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: "forbidden" }, 403);
        }

        if (!["approved", "half_paid"].includes(room.status)) {
          return json({ error: "chat_not_active" }, 409);
        }

        await db.prepare(`
          INSERT INTO messages
          (id, room_id, sender_id, type, ciphertext, sensitive)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          uuid(),
          body.room_id,
          String(user.id),
          body.type || "text",
          body.message,
          body.sensitive ? 1 : 0
        ).run();

        return json({ status: "sent" });
      }

      /* ======================================================
         GET MY CHATS
         ====================================================== */
      if (path === "/api/chat/my" && method === "GET") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const { results } = await db.prepare(`
          SELECT r.*,
            (SELECT ciphertext FROM messages m
             WHERE m.room_id=r.id
             ORDER BY created_at DESC LIMIT 1) AS last_message
          FROM chat_rooms r
          WHERE r.buyer_id=? OR r.seller_user_id=?
          ORDER BY r.created_at DESC
        `).bind(String(user.id), String(user.id)).all();

        return json(results || []);
      }

      /* ======================================================
         FETCH MESSAGES
         ====================================================== */
      if (path === "/api/chat/messages" && method === "GET") {
        const user = await auth();
        if (!user) return json({ error: "unauthorized" }, 401);

        const room_id = url.searchParams.get("room_id");

        const room = await db.prepare(`
          SELECT buyer_id, seller_user_id
          FROM chat_rooms WHERE id=?
        `).bind(room_id).first();

        if (!room) return json({ error: "room_not_found" }, 404);

        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: "forbidden" }, 403);
        }

        const { results } = await db.prepare(`
          SELECT *
          FROM messages
          WHERE room_id=?
          ORDER BY created_at ASC
        `).bind(room_id).all();

        return json(results || []);
      }

      /* ======================================================
         ADMIN: LIST ALL ROOMS
         ====================================================== */
      if (path === "/api/chat/admin/rooms" && method === "GET") {
        const user = await auth();
        if (!user || user.role !== "admin") return json({ error: "admin_only" }, 403);

        const status = url.searchParams.get("status") || "";
        let q = `
          SELECT r.*,
            (SELECT COUNT(*) FROM messages m WHERE m.room_id=r.id) AS message_count
          FROM chat_rooms r`;
        const binds = [];
        if (status) { q += " WHERE r.status=?"; binds.push(status); }
        q += " ORDER BY r.created_at DESC LIMIT 200";

        const { results } = await db.prepare(q).bind(...binds).all();
        return json(results || []);
      }

      /* ======================================================
         ADMIN: CLOSE / FORCE-CLOSE ROOM
         ====================================================== */
      if (path === "/api/chat/admin/close" && method === "POST") {
        const user = await auth();
        if (!user || user.role !== "admin") return json({ error: "admin_only" }, 403);

        const body = await req.json();
        if (!body.room_id) return json({ error: "missing_room_id" }, 400);

        const room = await db.prepare("SELECT id FROM chat_rooms WHERE id=?").bind(body.room_id).first();
        if (!room) return json({ error: "room_not_found" }, 404);

        await db.prepare("UPDATE chat_rooms SET status='closed' WHERE id=?").bind(body.room_id).run();
        return json({ message: "Room closed", room_id: body.room_id });
      }

      return json({ error: "not_found" }, 404);

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "server_error",
          message: err.message
        }),
        { status: 500, headers }
      );
    }
  }
};
