import jwt from '@tsndr/cloudflare-worker-jwt';

/* ================= AUTO-CLEANUP (scheduled) =================
   Purane chats/messages delete karta hai taaki DB load na bare.
   TTL env vars se control hota hai (default 12h / 24h). */
async function cleanup(env, db) {
  const now = Date.now();
  const globalTTL = (parseInt(env.GLOBAL_TTL_HOURS || '12', 10)) * 3600 * 1000;
  const privateTTL = (parseInt(env.PRIVATE_TTL_HOURS || '24', 10)) * 3600 * 1000;
  const roomTTL = (parseInt(env.ROOM_TTL_HOURS || '24', 10)) * 3600 * 1000;

  const gCut = new Date(now - globalTTL).toISOString();
  const pCut = new Date(now - privateTTL).toISOString();
  const rCut = new Date(now - roomTTL).toISOString();

  // 1. voice media KV keys â€” pehle delete karo, phir rows
  const oldMedia = await db.prepare(`
    SELECT media FROM global_messages WHERE media IS NOT NULL AND created_at < ?
    UNION
    SELECT media FROM messages WHERE media IS NOT NULL AND created_at < ?
  `).bind(gCut, pCut).all();

  if (oldMedia && oldMedia.results) {
    for (const row of oldMedia.results) {
      if (row.media) {await env.chat_media.delete(row.media).catch(() => {});}
    }
  }

  // 2. purani global + private messages
  await db.prepare('DELETE FROM global_messages WHERE created_at < ?').bind(gCut).run();
  await db.prepare('DELETE FROM messages WHERE created_at < ?').bind(pCut).run();

  // 3. closed chat rooms (cascade â†’ unke messages bhi)
  await db.prepare(
    "DELETE FROM chat_rooms WHERE status='closed' AND closed_at IS NOT NULL AND closed_at < ?"
  ).bind(rCut).run();

  // 4. purani ended/missed calls (cascade â†’ call_events)
  await db.prepare(
    "DELETE FROM calls WHERE status IN ('ended','missed') AND created_at < ?"
  ).bind(rCut).run();

  return { deleted: true };
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await cleanup(env, env.chat_db);
      console.log('cleanup ok', r);
    } catch (err) {
      console.error('cleanup failed', err.message);
    }
  },

  async fetch(req, env) {

    /* ================= CORS ================= */
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://bgmi-frontend.vercel.app', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-XSS-Protection': '1; mode=block',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    };

    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const db = env.CHAT_DB || env.chat_db;

      /* ================= HEALTH ================= */
      if (path === '/health' || path === '/api/chat/health') {
        return json({ service: 'chat', version: '1.1.1', status: 'running' });
      }

      /* ================= HELPERS ================= */
      const uuid = () => crypto.randomUUID();
      const CHANNELS = ['bgmi', 'free_fire', 'general'];

      function dataUriToBytes(dataUri) {
        const m = /^data:(.*);base64,(.*)$/.exec(dataUri || '');
        if (!m) {return null;}
        const bin = atob(m[2]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {arr[i] = bin.charCodeAt(i);}
        return { bytes: arr, mime: m[1] };
      }

      async function storeMedia(dataUri) {
        const parsed = dataUriToBytes(dataUri);
        if (!parsed) {return null;}
        if (parsed.bytes.byteLength > 900 * 1024) {throw new Error('media_too_large');}
        const key = 'med_' + uuid();
        await env.chat_media.put(key, parsed.bytes, { metadata: { mime: parsed.mime } });
        return key;
      }

      const displayName = (user) =>
        (user.name || user.username || '').slice(0, 30) ||
        String(user.email || user.id).split('@')[0] ||
        'User#' + user.id;

      async function auth() {
        const h = req.headers.get('Authorization');
        if (!h || !h.startsWith('Bearer ')) {return null;}

        const token = h.slice(7);
        let valid = false;
        try { valid = await jwt.verify(token, env.JWT_SECRET); } catch (e) { return null; }

        if (!valid) {return null;}

        const dec = jwt.decode(token);
        const payload = dec && dec.payload;
        if (!payload || !payload.id) {return null;}
        return payload;
      }

      const safeCallPayload = (raw) => {
        try { return JSON.parse(raw); } catch { return null; }
      };

      /* ======================================================
         CREATE CHAT / BUY REQUEST
         ====================================================== */
      if (path === '/api/chat/create' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        const intent = body.intent === 'buy' ? 'buy' : 'chat';

        if (body.order_id === undefined || body.order_id === null || body.seller_user_id === undefined || body.seller_user_id === null) {
          return json({ error: 'missing_fields' }, 400);
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
          status: 'requested',
          intent,
          reused: false
        });
      }

      /* ======================================================
         GET SINGLE CHAT ROOM
         ====================================================== */
      if (path === '/api/chat/room' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const room_id = url.searchParams.get('room_id');

        const room = await db.prepare(`
          SELECT *
          FROM chat_rooms
          WHERE id=?
        `).bind(room_id).first();

        if (!room) {return json({ error: 'room_not_found' }, 404);}

        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }

        return json(room);
      }


      /* ======================================================
         SELLER APPROVE / REJECT
         ====================================================== */
      if (path === '/api/chat/approve' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        if (!body.room_id || typeof body.approve !== 'boolean') {
          return json({ error: 'invalid_payload' }, 400);
        }

        const room = await db.prepare(`
          SELECT status
          FROM chat_rooms
          WHERE id=? AND seller_user_id=?
        `).bind(body.room_id, String(user.id)).first();

        if (!room) {return json({ error: 'room_not_found' }, 404);}
        if (room.status !== 'requested')
        {return json({ error: 'invalid_room_state' }, 409);}

        await db.prepare(`
          UPDATE chat_rooms
          SET status=?, approved_at=CURRENT_TIMESTAMP,
              closed_at=CASE WHEN ?='closed' THEN CURRENT_TIMESTAMP ELSE closed_at END
          WHERE id=?
        `).bind(
          body.approve ? 'approved' : 'closed',
          body.approve ? 'approved' : 'closed',
          body.room_id
        ).run();

        return json({ status: body.approve ? 'approved' : 'rejected' });
      }

      /* ======================================================
         HALF PAYMENT DONE (BUYER ONLY)
         ====================================================== */
      if (path === '/api/chat/half-payment' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();

        const room = await db.prepare(`
          SELECT status
          FROM chat_rooms
          WHERE id=? AND buyer_id=?
        `).bind(body.room_id, String(user.id)).first();

        if (!room) {return json({ error: 'room_not_found' }, 404);}
        if (room.status !== 'approved')
        {return json({ error: 'invalid_state' }, 409);}

        await db.prepare(`
          UPDATE chat_rooms
          SET status='half_paid'
          WHERE id=?
        `).bind(body.room_id).run();

        return json({ status: 'half_paid' });
      }

      /* ======================================================
         SEND MESSAGE (SECURE)
         ====================================================== */
      if (path === '/api/chat/send' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        if (!body.room_id) {
          return json({ error: 'missing_fields' }, 400);
        }

        const room = await db.prepare(`
          SELECT buyer_id, seller_user_id, status
          FROM chat_rooms
          WHERE id=?
        `).bind(body.room_id).first();

        if (!room) {return json({ error: 'room_not_found' }, 404);}

        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }

        if (!['approved', 'half_paid'].includes(room.status)) {
          return json({ error: 'chat_not_active' }, 409);
        }

        let type = body.type || 'text';
        let media = null;
        let media_type = null;
        let message = body.message || null;

        // voice message â†’ media stored in KV
        if (body.media) {
          media = await storeMedia(body.media);
          if (!media) {return json({ error: 'invalid_media' }, 400);}
          media_type = body.media_type || 'audio/webm';
          type = 'voice';
          message = message || '';
        } else if (type === 'voice') {
          return json({ error: 'media_required' }, 400);
        } else {
          if (!message || !String(message).trim()) {
            return json({ error: 'missing_fields' }, 400);
          }
          message = String(message).slice(0, 1000);
        }

        const effect = ['glitch', 'rainbow', 'sparkle', 'fire', 'neon'].includes(body.effect)
          ? body.effect
          : null;

        await db.prepare(`
          INSERT INTO messages
          (id, room_id, sender_id, type, ciphertext, sensitive, media, media_type, effect)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          uuid(),
          body.room_id,
          String(user.id),
          type,
          message,
          body.sensitive ? 1 : 0,
          media,
          media_type,
          effect
        ).run();

        return json({ status: 'sent', type, media });
      }

      /* ======================================================
         GET MY CHATS
         ====================================================== */
      if (path === '/api/chat/my' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

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
      if (path === '/api/chat/messages' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const room_id = url.searchParams.get('room_id');

        const room = await db.prepare(`
          SELECT buyer_id, seller_user_id
          FROM chat_rooms WHERE id=?
        `).bind(room_id).first();

        if (!room) {return json({ error: 'room_not_found' }, 404);}

        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
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
         GLOBAL CHAT: CHANNELS
         ====================================================== */
      if (path === '/api/chat/global/channels' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const counts = {};
        for (const ch of CHANNELS) {
          const row = await db.prepare(
            'SELECT COUNT(*) AS n FROM global_messages WHERE channel=?'
          ).bind(ch).first();
          counts[ch] = row ? row.n : 0;
        }

        return json({
          channels: CHANNELS.map((id) => ({
            id,
            name: id === 'bgmi' ? 'BGMI' : id === 'free_fire' ? 'Free Fire' : 'General',
            messages: counts[id]
          }))
        });
      }

      /* ======================================================
         GLOBAL CHAT: FETCH MESSAGES
         ====================================================== */
      if (path === '/api/chat/global/messages' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const channel = url.searchParams.get('channel') || 'bgmi';
        if (!CHANNELS.includes(channel)) {return json({ error: 'invalid_channel' }, 400);}

        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 200);
        const { results } = await db.prepare(`
          SELECT id, channel, sender_id, username, message, media, media_type, effect, created_at
          FROM global_messages
          WHERE channel=?
          ORDER BY created_at DESC LIMIT ?
        `).bind(channel, limit).all();

        return json((results || []).reverse());
      }

      /* ======================================================
         GLOBAL CHAT: SEND MESSAGE (rate-limited)
         ====================================================== */
      if (path === '/api/chat/global/send' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        const channel = body.channel || 'bgmi';
        if (!CHANNELS.includes(channel)) {return json({ error: 'invalid_channel' }, 400);}

        const last = await db.prepare(
          'SELECT created_at FROM global_messages WHERE sender_id=? ORDER BY created_at DESC LIMIT 1'
        ).bind(String(user.id)).first();
        if (last) {
          const elapsed = Date.now() - new Date(last.created_at).getTime();
          if (elapsed < 3000) {return json({ error: 'slow_down', wait: Math.ceil((3000 - elapsed) / 1000) }, 429);}
        }

        let type = 'text';
        let media = null;
        let media_type = null;
        const message = String(body.message || '').slice(0, 500);

        if (body.media) {
          media = await storeMedia(body.media);
          if (!media) {return json({ error: 'invalid_media' }, 400);}
          media_type = body.media_type || 'audio/webm';
          type = 'voice';
        } else if (!message.trim()) {
          return json({ error: 'missing_fields' }, 400);
        }

        const effect = ['glitch', 'rainbow', 'sparkle', 'fire', 'neon'].includes(body.effect)
          ? body.effect
          : null;

        await db.prepare(`
          INSERT INTO global_messages
          (id, channel, sender_id, username, message, media, media_type, effect)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          uuid(),
          channel,
          String(user.id),
          displayName(user),
          message,
          media,
          media_type,
          effect
        ).run();

        return json({ status: 'sent', type, media });
      }

      /* ======================================================
         MEDIA (VOICE) BLOB FROM KV
         ====================================================== */
      if (path.startsWith('/api/chat/media/') && method === 'GET') {
        const key = path.split('/').pop();
        const got = await env.chat_media.getWithMetadata(key, { type: 'arrayBuffer' });
        if (got.value === null) {return json({ error: 'not_found' }, 404);}

        const mime = (got.metadata && got.metadata.mime) || 'audio/webm';
        return new Response(got.value, {
          headers: {
            'Content-Type': mime,
            'Access-Control-Allow-Origin': 'https://bgmi-frontend.vercel.app', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'inline'
          }
        });
      }

      /* ======================================================
         ðŸ“ž CALLING SYSTEM (WebRTC signaling relay)
         ====================================================== */
      if (path === '/api/chat/call/start' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        const room_id = body.room_id;
        const kind = body.kind === 'video' ? 'video' : 'audio';

        const room = await db.prepare(
          'SELECT buyer_id, seller_user_id, status FROM chat_rooms WHERE id=?'
        ).bind(room_id).first();
        if (!room) {return json({ error: 'room_not_found' }, 404);}
        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }
        if (!['approved', 'half_paid'].includes(room.status)) {
          return json({ error: 'chat_not_active' }, 409);
        }

        const callee_id = String(user.id) === String(room.buyer_id)
          ? room.seller_user_id : room.buyer_id;

        const active = await db.prepare(
          "SELECT id FROM calls WHERE room_id=? AND status IN ('ringing','connected') LIMIT 1"
        ).bind(room_id).first();
        if (active) {return json({ error: 'call_already_active', call_id: active.id }, 409);}

        const call_id = uuid();
        await db.prepare(`
          INSERT INTO calls (id, room_id, caller_id, callee_id, kind, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'ringing', CURRENT_TIMESTAMP)
        `).bind(call_id, room_id, String(user.id), callee_id, kind).run();

        return json({ call_id, kind, callee_id, status: 'ringing' });
      }

      if (path === '/api/chat/call/event' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        const { call_id, type, payload } = body;
        if (!call_id || !['offer', 'answer', 'ice', 'hangup'].includes(type)) {
          return json({ error: 'invalid_payload' }, 400);
        }

        const call = await db.prepare('SELECT room_id, caller_id, callee_id FROM calls WHERE id=?').bind(call_id).first();
        if (!call) {return json({ error: 'call_not_found' }, 404);}
        if (![call.caller_id, call.callee_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }

        const to_id = String(user.id) === String(call.caller_id) ? call.callee_id : call.caller_id;
        await db.prepare(`
          INSERT INTO call_events (call_id, from_id, to_id, type, payload, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(call_id, String(user.id), to_id, type, JSON.stringify(payload || null)).run();

        return json({ status: 'stored', call_id });
      }

      if (path === '/api/chat/call/poll' && method === 'GET') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const room_id = url.searchParams.get('room_id');
        const since = Number(url.searchParams.get('since') || 0);
        const room = await db.prepare(
          'SELECT buyer_id, seller_user_id FROM chat_rooms WHERE id=?'
        ).bind(room_id).first();
        if (!room) {return json({ error: 'room_not_found' }, 404);}
        if (![room.buyer_id, room.seller_user_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }

        const call = await db.prepare(`
          SELECT * FROM calls WHERE room_id=? AND status IN ('ringing','connected')
          ORDER BY created_at DESC LIMIT 1
        `).bind(room_id).first();

        const events = await db.prepare(`
          SELECT * FROM call_events WHERE call_id=? AND to_id=? AND id>?
          ORDER BY id ASC
        `).bind(call ? call.id : '', String(user.id), since).all();

        return json({
          call: call ? { id: call.id, caller_id: call.caller_id, callee_id: call.callee_id, kind: call.kind, status: call.status } : null,
          events: (events.results || []).map(e => ({
            id: e.id,
            type: e.type,
            payload: safeCallPayload(e.payload)
          }))
        });
      }

      if (path === '/api/chat/call/state' && method === 'POST') {
        const user = await auth();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const body = await req.json();
        const { call_id, status } = body;
        if (!call_id || !['ringing', 'connected', 'ended', 'missed'].includes(status)) {
          return json({ error: 'invalid_payload' }, 400);
        }

        const call = await db.prepare(
          'SELECT caller_id, callee_id, status AS cur FROM calls WHERE id=?'
        ).bind(call_id).first();
        if (!call) {return json({ error: 'call_not_found' }, 404);}
        if (![call.caller_id, call.callee_id].includes(String(user.id))) {
          return json({ error: 'forbidden' }, 403);
        }

        const setConnected = status === 'connected' || (status === 'ringing' && call.cur === 'ringing');
        await db.prepare(`
          UPDATE calls SET status=?, ended_at=CASE WHEN ? IN ('ended','missed') THEN CURRENT_TIMESTAMP ELSE ended_at END
          WHERE id=?
        `).bind(status, status, call_id).run();

        return json({ status, call_id });
      }

      /* ======================================================
         ADMIN: LIST ALL ROOMS
         ====================================================== */
      if (path === '/api/chat/admin/rooms' && method === 'GET') {
        const user = await auth();
        if (!user || user.role !== 'admin') {return json({ error: 'admin_only' }, 403);}

        const status = url.searchParams.get('status') || '';
        let q = `
          SELECT r.*,
            (SELECT COUNT(*) FROM messages m WHERE m.room_id=r.id) AS message_count
          FROM chat_rooms r`;
        const binds = [];
        if (status) { q += ' WHERE r.status=?'; binds.push(status); }
        q += ' ORDER BY r.created_at DESC LIMIT 200';

        const { results } = await db.prepare(q).bind(...binds).all();
        return json(results || []);
      }

      /* ======================================================
         ADMIN: CLOSE / FORCE-CLOSE ROOM
         ====================================================== */
      if (path === '/api/chat/admin/close' && method === 'POST') {
        const user = await auth();
        if (!user || user.role !== 'admin') {return json({ error: 'admin_only' }, 403);}

        const body = await req.json();
        if (!body.room_id) {return json({ error: 'missing_room_id' }, 400);}

        const room = await db.prepare('SELECT id FROM chat_rooms WHERE id=?').bind(body.room_id).first();
        if (!room) {return json({ error: 'room_not_found' }, 404);}

        await db.prepare("UPDATE chat_rooms SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.room_id).run();
        return json({ message: 'Room closed', room_id: body.room_id });
      }

      return json({ error: 'not_found' }, 404);

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'server_error',
          message: err.message
        }),
        { status: 500, headers }
      );
    }
  }
};
