/**
 * =====================================================
 * BGMI Marketplace Service v5.1.0
 * =====================================================
 * ✅ Listings CRUD + single listing GET
 * ✅ Reviews (create + seller aggregates)
 * ✅ Purchases (escrow tracking + ensureSeller)
 * ✅ Admin moderation (list all, moderate status)
 * ✅ JWT Auth (shared secret)
 * ✅ DeepL translation proxy (secure backend)
 * ✅ Badge system (new/verified/trusted/secure/diamond)
 * ✅ Rate limiting + lazy cleanup
 * =====================================================
 */

const hits = new Map();
let lastCleanup = 0;

export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await env.MARKETPLACE_DB.prepare("DELETE FROM listings WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','-10 day')").run();
      console.log('cron purge listings:', r.meta.changes);
    } catch (e) { console.error('purge error:', e.message); }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const db = env.MARKETPLACE_DB;

    // Lazy cleanup: purge rate limiter entries older than 5 minutes
    const now = Date.now();
    if (now - lastCleanup > 60000) {
      lastCleanup = now;
      const cutoff = now - 300000;
      for (const [k, v] of hits) { if (v.t < cutoff) hits.delete(k); }
    }

    const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-XSS-Protection': '1; mode=block',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    };

    const CORS_HEADERS = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://bgmi-frontend.vercel.app',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      ...SECURITY_HEADERS
    };
    if (method === 'OPTIONS') {return new Response(null, { status: 204, headers: CORS_HEADERS });}

    const sendJSON = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: CORS_HEADERS });

    const rate = (key, max, windowMs) => {
      const now = Date.now();
      const rec = hits.get(key);
      if (!rec || now - rec.t > windowMs) {
        hits.set(key, { t: now, n: 1 });
        return true;
      }
      if (rec.n >= max) {return false;}
      rec.n++;
      return true;
    };
    const cleanVal = (v, max) => String(v ?? '').replace(/[<>&'"`]/g, '').trim().slice(0, max);
    const safeParseArr = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

    const safeJSON = (v, d = []) => {
      try { return JSON.parse(v || '[]'); } catch { return d; }
    };

    // Base64URL decode helper
    function base64UrlDecode(str) {
      const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bin = atob(padded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    // Verify JWT using Web Crypto API (compatible with auth service)
    async function verifyJWT(req) {
      const auth = req.headers.get('Authorization');
      if (!auth) {return null;}
      const token = auth.split(' ')[1];
      if (!token) {return null;}
      
      try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        
        const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(env.JWT_SECRET),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify']
        );
        
        const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(parts[2]), data);
        if (!valid) return null;
        
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
        if (!payload) return null;
        if (payload.exp && payload.exp * 1000 < Date.now()) return null;
        
        const { results } = await db.prepare(
          'SELECT role FROM users WHERE id=?'
        ).bind(String(payload.id)).all();
        if (results.length) {payload.role = results[0].role;}
        
        // cache username so admin panel can show seller names
        try {
          const uname = String(payload.name || payload.username || '').slice(0, 60);
          if (uname) {
            await db.prepare(
              `INSERT INTO users (id, username, role, created_at)
               VALUES (?,?,?,datetime('now'))
               ON CONFLICT(id) DO UPDATE SET username=excluded.username`
            ).bind(String(payload.id), uname, String(payload.role || 'user')).run();
          }
        } catch {
        // Ignore username caching errors
        }
        return payload;
      } catch {
        return null;
      }
    }

    async function ensureSeller(userId) {
      const sid = String(userId);
      const s = await db.prepare('SELECT * FROM sellers WHERE CAST(user_id AS TEXT)=?')
        .bind(sid).first();
      if (!s) {
        await db.prepare(
          "INSERT OR IGNORE INTO sellers (user_id, stars, review_count, badge, status, total_sales, total_revenue, pending_commission, hidden) VALUES (?,0,0,'new','active',0,0,0,0)"
        ).bind(sid).run();
      }
    }

    async function sellerHidden(userId) {
      const s = await db.prepare(
        'SELECT hidden FROM sellers WHERE CAST(user_id AS TEXT)=?'
      ).bind(String(userId)).first();
      return !!(s && Number(s.hidden) === 1);
    }

    const normalize = r => ({
      ...r,
      category: r.category || 'account',
      points: r.points || 0,
      delivery_time: r.delivery_time || '',
      meetup_available: r.meetup_available || 0,
      mythic_items: safeJSON(r.mythic_items),
      legendary_items: safeJSON(r.legendary_items),
      honor_gift: safeJSON(r.honor_gift ?? r.gift_items),
      upgraded_guns: safeJSON(r.upgraded_guns),
      titles: safeJSON(r.titles),
      x_suit: safeJSON(r.x_suit),
      supercar: safeJSON(r.supercar),
      ultimate: safeJSON(r.ultimate),
      images: safeJSON(r.images),
      rate_per_1k: r.rate_per_1k || 0,
      boost_items: r.boost_items || null,
      express_enabled: r.express_enabled || 0,
      express_charge: r.express_charge || 0,
    });

    /* ================= HEALTH ================= */
    if (path === '/api/health') {
      return sendJSON({ service: 'marketplace', version: '5.1.0', status: 'running' });
    }

    /* ================= DEEPL TRANSLATE PROXY ================= */
    if (path === '/api/translate' && method === 'POST') {
      const rateKey = `tr:${request.headers.get('cf-connecting-ip') || 'anon'}`;
      if (!rate(rateKey, 30, 60000)) {
        return sendJSON({ error: 'Too many translation requests' }, 429);
      }
      try {
        const b = await request.json().catch(() => ({}));
        const texts = Array.isArray(b.text) ? b.text : (typeof b.text === 'string' ? [b.text] : []);
        const safeTexts = texts.map(t => String(t || '').slice(0, 5000));
        const targetLang = String(b.target_lang || '').toUpperCase().replace(/[^A-Z-]/g, '').slice(0, 5);
        if (!safeTexts.length || !targetLang) {
          return sendJSON({ error: 'text (array or string) and target_lang required' }, 400);
        }
        const DEEPL_KEY = env.DEEPL_API_KEY;
        if (!DEEPL_KEY) {
          return sendJSON({ error: 'Translation service not configured' }, 503);
        }
        const deeplRes = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: {
            'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text: safeTexts.slice(0, 50), target_lang: targetLang })
        });
        const deeplData = await deeplRes.json();
        if (!deeplRes.ok) {
          return sendJSON({ error: 'Translation failed' }, 500);
        }
        return sendJSON({
          translations: (deeplData.translations || []).map(t => t.text)
        });
      } catch (err) {
        return sendJSON({ error: 'Translation proxy error' }, 500);
      }
    }

    /* ================= PRICE CONFIG (estimate prices, admin-editable) ================= */
    const PRICE_DEFAULTS = {
      level_per: 8,            // â‚¹ per level
      rank_gold: 10,
      rank_platinum: 30,
      rank_ace: 50,
      rank_diamond: 40,
      rank_conquer: 200,
      mythic: 180,
      legendary: 100,
      gift: 1000,
      titles: 100,
      guns: 300,
      x_suit: 400,
      supercar: 1500,
      ultimate: 250,
      min_price: 999,
      round_to: 50,
      pop_per_point: 1,       // legacy per popularity point
      pop_rate_1k: 10         // per 1,000 popularity points (admin default)
    };

    if (path === '/api/price-config' && method === 'GET') {
      try {
        const { results } = await db.prepare('SELECT key, value FROM price_config').all();
        const overrides = {};
        for (const r of results) {overrides[r.key] = Number(r.value);}
        return sendJSON({ ...PRICE_DEFAULTS, ...overrides });
      } catch (err) {
        return sendJSON({ ...PRICE_DEFAULTS });
      }
    }

    if (path === '/api/admin/price-config' && method === 'PUT') {
      const user = await verifyJWT(request);
      if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

      try {
        const b = await request.json().catch(() => ({}));
        const updates = b.config || b;
        if (!updates || typeof updates !== 'object') {return sendJSON({ error: 'Config object required' }, 400);}

        let n = 0;
        for (const [key, raw] of Object.entries(updates)) {
          const value = Number(raw);
          if (!Object.prototype.hasOwnProperty.call(PRICE_DEFAULTS, key)) {continue;}
          if (!isFinite(value) || value < 0 || value > 10000000) {return sendJSON({ error: `Invalid value for ${key}` }, 400);}
          await db.prepare(
            `INSERT INTO price_config (key, value, updated_at) VALUES (?,?,datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
          ).bind(key, value).run();
          n++;
        }
        if (!n) {return sendJSON({ error: 'No valid keys provided' }, 400);}
        const { results } = await db.prepare('SELECT key, value FROM price_config').all();
        const overrides = {};
        for (const r of results) {overrides[r.key] = Number(r.value);}
        return sendJSON({ message: `Saved ${n} price(s)`, config: { ...PRICE_DEFAULTS, ...overrides } });
      } catch(err) {
        return sendJSON({ error: 'Failed to update config' }, 500);
      }
    }

    try {
      /* ================= SELLER VERIFY STATUS (must be before /api/seller/:id) ================= */
      if (path === '/api/seller/verify-status' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const req = await db.prepare(
          `SELECT id, status, badge, reason, created_at, reviewed_at
           FROM seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1`
        ).bind(String(user.id)).first();

        const seller = await db.prepare(
          'SELECT badge, status FROM sellers WHERE CAST(user_id AS TEXT)=?'
        ).bind(String(user.id)).first();

        return sendJSON({
          request: req || null,
          badge: seller?.badge || 'new',
          verified: !!seller && seller.badge !== 'new'
        });
      }

      /* ================= SELLER PROFILE ================= */
      if (path.startsWith('/api/seller/') && method === 'GET') {
        const parts = path.split('/');
        const sellerId = String(decodeURIComponent(parts[3] || ''));
        const seller = await db.prepare(
          `SELECT user_id, stars, review_count, badge, status, total_sales, total_revenue, city, meetup_note, pending_commission, hidden
           FROM sellers WHERE CAST(user_id AS TEXT)=?`
        ).bind(sellerId).first();

        if (!seller) {return sendJSON({ error: 'Seller not found' }, 404);}

        const viewer = await verifyJWT(request);
        const isOwner = viewer && String(viewer.id) === String(seller.user_id);
        const isAdmin = viewer && String(viewer.role) === 'admin';

        if (Number(seller.hidden) === 1 && !isOwner && !isAdmin) {
          return sendJSON({ error: 'Seller not found' }, 404);
        }

        const listings = await db.prepare(
          "SELECT * FROM listings WHERE CAST(seller_id AS TEXT)=? AND status='available' AND deleted_at IS NULL"
        ).bind(sellerId).all();

        const reviews = await db.prepare(
          `SELECT id, buyer_id, stars, comment, reply, created_at
           FROM reviews WHERE CAST(seller_id AS TEXT)=?
           ORDER BY created_at DESC LIMIT 20`
        ).bind(sellerId).all();

        const resp = {
          user_id: seller.user_id,
          name: `Seller ${seller.user_id}`,
          avg_rating: Number(seller.stars || 0).toFixed(1),
          review_count: seller.review_count || 0,
          seller_verified: seller.badge !== 'new',
          badge: seller.badge,
          total_sales: seller.total_sales,
          total_revenue: seller.total_revenue,
          city: seller.city || '',
          meetup_note: seller.meetup_note || '',
          listings: listings.results.map(normalize),
          reviews: reviews.results
        };
        if (isOwner || isAdmin) {
          resp.pending_commission = Number(seller.pending_commission || 0);
          resp.hidden = Number(seller.hidden || 0);
        }

        // Check if seller has any KYC verified status
        let kyc_verified = false;
        try {
          const kyc = await db.prepare('SELECT kyc_verified FROM users WHERE id=?').bind(String(seller.user_id)).first();
          kyc_verified = !!(kyc && kyc.kyc_verified);
        } catch {}
        resp.kyc_verified = kyc_verified;

        return sendJSON(resp);
      }

      /* ================= GET LISTINGS ================= */
      if (path === '/api/listings' && method === 'GET') {
        let q = "SELECT l.*, s.city AS seller_city FROM listings l LEFT JOIN sellers s ON CAST(s.user_id AS TEXT)=l.seller_id WHERE l.status='available' AND l.deleted_at IS NULL AND COALESCE(s.hidden,0)=0";
        const binds = [];
        const search = url.searchParams.get('q');
        const filter = url.searchParams.get('filter');
        const category = url.searchParams.get('category');
        const city = url.searchParams.get('city');
        const user = await verifyJWT(request);

        if (search) {
          q += ' AND (l.title LIKE ? OR l.uid LIKE ? OR l.highest_rank LIKE ?)';
          binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (category && (category === 'account' || category === 'popularity')) {
          q += ' AND l.category=?';
          binds.push(category);
        }

        if (city) {
          const cleanCity = cleanVal(city, 40);
          if (cleanCity) {
            q += ' AND (l.city LIKE ? OR s.city LIKE ?)';
            binds.push(`%${cleanCity}%`, `%${cleanCity}%`);
          }
        }

        if (filter === 'own' && user) {
          q += ' AND CAST(l.seller_id AS TEXT)=?';
          binds.push(String(user.id));
        }

        if (filter === 'meetup') {q += ' AND l.meetup_available=1';}
        if (filter === 'price_high') {q += ' ORDER BY l.price DESC';}
        else if (filter === 'price_low') {q += ' ORDER BY l.price ASC';}
        else {q += ' ORDER BY l.created_at DESC';}

        let limit = Math.min(Number(url.searchParams.get('limit') || 100), 200);
        let offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isFinite(limit) || limit < 1) limit = 100;
        if (!Number.isFinite(offset) || offset < 0) offset = 0;
        q += ' LIMIT ? OFFSET ?';
        binds.push(limit, offset);

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results.map(normalize));
      }

      /* ================= GET SINGLE LISTING ================= */
      if (path.startsWith('/api/listings/') && method === 'GET' && !path.includes('/create')) {
        const listingId = Number(path.split('/')[3]);
        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(listingId).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}
        return sendJSON(normalize(listing));
      }

      /* ================= CREATE LISTING ================= */
      if (path === '/api/listings/create' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate(`create:${user.id}`, 5, 60000)) {
          return sendJSON({ error: 'Too many listings. Try later.' }, 429);
        }
        await ensureSeller(user.id);

        if (await sellerHidden(user.id)) {
          return sendJSON({ error: 'Your seller account is hidden due to unpaid commission. Pay your pending commission to get unlisted.' }, 403);
        }

        const b = await request.json().catch(() => ({}));

        const category = b.category === 'popularity' ? 'popularity' : 'account';
        const cleanUid = category === 'account'
          ? String(b.uid || '').replace(/[^0-9]/g, '').slice(0, 12)
          : '';
        let cleanTitle = String(b.title || '').replace(/[<>&'"`]/g, '').trim().slice(0, 80);
        if (!cleanTitle) {cleanTitle = category === 'popularity' ? 'BGMI Popularity Package' : 'BGMI Account';}
        let price = Number(b.price);
        if (!Number.isFinite(price) || price < 1) {price = 1;}
        if (price > 10000000) {price = 10000000;}
        let points = category === 'popularity' ? (Number(b.points) || 0) : 0;
        if (category === 'popularity' && points < 1) {points = 100;}
        if (points > 10000000) {points = 10000000;}
        let rate1k = category === 'popularity' ? (Number(b.rate_per_1k) || 0) : 0;
        if (rate1k < 0) {rate1k = 0;}
        if (rate1k > 1000000) {rate1k = 1000000;}
        // Multi-item boost composition (popularity): [{n:name, v:points_each, q:qty}, ...]
        let boostItems = null;
        if (category === 'popularity' && b.boost_items) {
          try {
            const arr = JSON.parse(String(b.boost_items));
            if (Array.isArray(arr)) {
              const clean = arr.slice(0, 40).map(it => ({
                n: String((it && it.n) || 'Boost').replace(/[<>&'"`]/g, '').trim().slice(0, 60) || 'Boost',
                v: Math.max(1, Math.min(10000000, Number(it && it.v) || 1)),
                q: Math.max(1, Math.min(999, Math.floor(Number(it && it.q) || 1)))
              })).filter(it => it.n);
              boostItems = clean.length ? JSON.stringify(clean) : null;
            }
          } catch (e) {boostItems = null;}
        }
        const cleanDesc = String(b.description || '').replace(/[<>&'"`]/g, '').trim().slice(0, 1000);
        const deliveryTime = String(b.delivery_time || '').replace(/[<>&'"`]/g, '').trim().slice(0, 60);
        const meetupAvailable = b.meetup_available === 1 || b.meetup_available === true || String(b.meetup_available) === '1' ? 1 : 0;
        const cleanCity = cleanVal(b.city, 40);

        if (cleanCity || b.meetup_note !== undefined) {
          await db.prepare(
            "UPDATE sellers SET city=COALESCE(?, city), meetup_note=COALESCE(?, meetup_note), updated_at=datetime('now') WHERE CAST(user_id AS TEXT)=?"
          ).bind(cleanCity || null, b.meetup_note !== undefined ? cleanVal(b.meetup_note, 120) || null : null, String(user.id)).run();
        }

        const expressEnabled = b.express_enabled === 1 || b.express_enabled === true || String(b.express_enabled) === '1' ? 1 : 0;
        const expressCharge = Math.max(0, Math.min(10000000, Number(b.express_charge) || 0));

        const insert = await db.prepare(
          `INSERT INTO listings
          (seller_id,uid,title,description,category,points,delivery_time,price,level,highest_rank,
           mythic_items,legendary_items,honor_gift,upgraded_guns,titles,
           x_suit,supercar,ultimate,images,meetup_available,city,
           rate_per_1k,boost_items,express_enabled,express_charge,status,avg_rating,review_count,seller_verified)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'available',0,0,0)`
        ).bind(
          String(user.id),
          cleanUid,
          cleanTitle,
          cleanDesc,
          category,
          points,
          deliveryTime,
          price,
          b.level || 0,
          b.highest_rank || '',
          JSON.stringify(b.mythic_items || []),
          JSON.stringify(b.legendary_items || []),
          JSON.stringify(b.honor_gift ?? (b.gift_items || [])),
          JSON.stringify(b.upgraded_guns || []),
          JSON.stringify(b.titles || []),
          JSON.stringify(b.x_suit || []),
          JSON.stringify(b.supercar || []),
          JSON.stringify(b.ultimate || []),
          JSON.stringify(b.images || []),
          meetupAvailable,
          cleanCity || null,
          rate1k,
          boostItems,
          expressEnabled,
          expressCharge
        ).run();

        return sendJSON({ message: 'Listing created', id: insert.meta?.last_row_id ?? insert.lastInsertRowid });
      }

      /* ================= EDIT LISTING ================= */
      if (path.startsWith('/api/listings/') && method === 'PATCH') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        const listingId = path.split('/')[3];
        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(listingId).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}
        if (String(listing.seller_id) !== String(user.id)
            && String(user.role).toLowerCase() !== 'admin') {
          return sendJSON({ error: 'Forbidden' }, 403);}
        const b = await request.json().catch(() => ({}));
        const st = String(b.status || '');
        if (!['available','sold','hidden'].includes(st)) {return sendJSON({ error: 'Invalid status' }, 400);}
        await db.prepare("UPDATE listings SET status=?, updated_at=datetime('now') WHERE id=?").bind(st, listingId).run();
        return sendJSON({ message: 'Status updated', id: Number(listingId), status: st });
      }

      if (path.startsWith('/api/listings/') && method === 'PUT') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const listingId = path.split('/')[3];
        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(listingId).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}

        if (String(listing.seller_id) !== String(user.id)
            && String(user.role).toLowerCase() !== 'admin') {
          return sendJSON({ error: 'Forbidden' }, 403);
        }

        const b = await request.json().catch(() => ({}));
        const price = Number(b.price);
        if (b.price !== undefined && (!Number.isFinite(price) || price < 1 || price > 10000000)) {
          return sendJSON({ error: 'Price must be between â‚¹1 and â‚¹10,000,000' }, 400);
        }
        const cleanTitle = b.title !== undefined ? cleanVal(b.title, 80) : undefined;
        if (b.title !== undefined && !cleanTitle) {return sendJSON({ error: 'Title required' }, 400);}
        const cleanDesc = b.description !== undefined ? cleanVal(b.description, 1000) : undefined;
        await db.prepare(
          `UPDATE listings SET
            title=?, description=?, price=?, level=?, highest_rank=?,
            mythic_items=?, legendary_items=?, honor_gift=?, upgraded_guns=?, titles=?,
            x_suit=?, supercar=?, ultimate=?, images=?, delivery_time=?, meetup_available=?, city=?,
            express_enabled=?, express_charge=?, account_highlights=?,
            updated_at=datetime('now')
           WHERE id=?`
        ).bind(
          cleanTitle ?? b.title ?? listing.title,
          (cleanDesc ?? b.description) || listing.description || '',
          price || b.price || Number(listing.price) || 0,
          b.level !== undefined ? (b.level || 0) : (listing.level ?? 0),
          b.highest_rank !== undefined ? (b.highest_rank || '') : (listing.highest_rank || ''),
          JSON.stringify(b.mythic_items !== undefined ? b.mythic_items : safeParseArr(listing.mythic_items)),
          JSON.stringify(b.legendary_items !== undefined ? b.legendary_items : safeParseArr(listing.legendary_items)),
          JSON.stringify(b.honor_gift !== undefined ? b.honor_gift : (b.gift_items !== undefined ? b.gift_items : safeParseArr(listing.honor_gift))),
          JSON.stringify(b.upgraded_guns !== undefined ? b.upgraded_guns : safeParseArr(listing.upgraded_guns)),
          JSON.stringify(b.titles !== undefined ? b.titles : safeParseArr(listing.titles)),
          JSON.stringify(b.x_suit !== undefined ? b.x_suit : safeParseArr(listing.x_suit)),
          JSON.stringify(b.supercar !== undefined ? b.supercar : safeParseArr(listing.supercar)),
          JSON.stringify(b.ultimate !== undefined ? b.ultimate : safeParseArr(listing.ultimate)),
          JSON.stringify(b.images !== undefined ? b.images : safeParseArr(listing.images)),
          b.delivery_time !== undefined ? (String(b.delivery_time || '').replace(/[<>&'"`]/g, '').trim().slice(0, 60) || null) : (listing.delivery_time || null),
          b.meetup_available !== undefined ? ((b.meetup_available === 1 || b.meetup_available === true || String(b.meetup_available) === '1') ? 1 : 0) : (Number(listing.meetup_available) || 0),
          b.city !== undefined ? (cleanVal(b.city, 40) || null) : (listing.city || null),
          (b.express_enabled === 1 || b.express_enabled === true || String(b.express_enabled) === '1') ? 1 : (listing.express_enabled || 0),
          b.express_charge !== undefined ? Math.max(0, Math.min(10000000, Number(b.express_charge) || 0)) : (listing.express_charge || 0),
          b.account_highlights !== undefined ? (String(b.account_highlights || '').replace(/[<>&'"`]/g, '').trim().slice(0, 500) || null) : (listing.account_highlights || null),
          listingId
        ).run();

        return sendJSON({ message: 'Listing updated' });
      }

      /* ================= DELETE LISTING ================= */
      if (path.startsWith('/api/listings/') && method === 'DELETE') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const listingId = path.split('/')[3];
        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(listingId).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}

        if (String(listing.seller_id) !== String(user.id)
            && String(user.role).toLowerCase() !== 'admin') {
          return sendJSON({ error: 'Forbidden' }, 403);
        }

        await db.prepare("UPDATE listings SET deleted_at=datetime('now') WHERE id=?").bind(listingId).run();
        return sendJSON({ message: 'Listing deleted' });
      }

      /* ================= MY ORDERS (buyer + seller views) ================= */
      if (path === '/api/purchases' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        const role = url.searchParams.get('role') === 'seller' ? 'seller' : 'buyer';
        const col = role === 'seller' ? 'p.seller_id' : 'p.buyer_id';
        const { results } = await db.prepare(
          `SELECT p.*, l.title, l.category, l.images
           FROM purchases p LEFT JOIN listings l ON l.id=p.listing_id
           WHERE CAST(${col} AS TEXT)=?
           ORDER BY p.created_at DESC LIMIT 100`
        ).bind(String(user.id)).all();
        const now = Date.now();
        const orders = (results || []).map(o => ({
          ...o,
          delivery_sla_minutes: 30,
          sla_minutes_left: Math.max(0, Math.round(30 - (now - new Date(String(o.created_at).replace(' ', 'T') + 'Z').getTime()) / 60000))
        }));
        return sendJSON({ orders });
      }

      /* ================= SELLER: MARK DELIVERED / CANCELLED ================= */
      if (path.startsWith('/api/purchases/') && method === 'PATCH') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        const parts = path.split('/');
        // ['', 'api', 'purchases', <id>, <action>?]
        const purchaseId = parts[3];
        const action = parts[4] || 'deliver'; // deliver | cancel
        const po = await db.prepare('SELECT * FROM purchases WHERE id=?').bind(purchaseId).first();
        if (!po) {return sendJSON({ error: 'Purchase not found' }, 404);}

        const isSeller = String(po.seller_id) === String(user.id);
        const isBuyer = String(po.buyer_id) === String(user.id);
        const isAdminU = String(user.role).toLowerCase() === 'admin';
        let deliveryStatus = po.delivery_status;
        let paymentStatus = po.payment_status;

        if (action === 'deliver') {
          if (!isSeller && !isAdminU) {return sendJSON({ error: 'Only the seller can mark delivery' }, 403);}
          deliveryStatus = 'delivered';
          paymentStatus = 'paid';
        } else if (action === 'cancel') {
          if ((!isBuyer && !isSeller && !isAdminU) || po.delivery_status === 'delivered' || po.delivery_status === 'cancelled') {
            return sendJSON({ error: 'Cannot cancel this order' }, 400);
          }
          deliveryStatus = 'cancelled';
        } else if (action === 'confirm' && isBuyer) {
          paymentStatus = 'completed';
        } else {
          return sendJSON({ error: 'Invalid action' }, 400);
        }

        await db.prepare(
          `UPDATE purchases SET delivery_status=?, payment_status=?, updated_at=datetime('now') WHERE id=?`
        ).bind(deliveryStatus, paymentStatus, purchaseId).run();

        // Reverse popularity points on cancellation
        if (action === 'cancel') {
          try {
            const cancelled = await db.prepare(
              'SELECT listing_id, buyer_id FROM purchases WHERE id=?'
            ).bind(purchaseId).first();
            if (cancelled) {
              const listInfo = await db.prepare(
                'SELECT category, points FROM listings WHERE id=?'
              ).bind(cancelled.listing_id).first();
              if (listInfo && listInfo.category === 'popularity' && listInfo.points > 0) {
                await db.prepare(
                  `INSERT INTO popularity (user_id, points, source, created_at)
                   VALUES (?, ?, 'cancellation_reversal', datetime('now'))`
                ).bind(String(cancelled.buyer_id), -Math.abs(listInfo.points)).run();
              }
            }
          } catch (e) { console.error('popularity reversal error:', e.message); }
        }

        return sendJSON({ message: 'Order updated', delivery_status: deliveryStatus, payment_status: paymentStatus });
      }

      /* ================= SELLER: SCHEDULE DELIVERY ================= */
      if (path === '/api/purchases/schedule' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) { return sendJSON({ error: 'Unauthorized' }, 401); }
        if (!rate(`sched:${user.id}`, 20, 60000)) return sendJSON({ error: 'Too many requests' }, 429);
        
        const b = await request.json().catch(() => ({}));
        if (!b.purchase_id || !b.scheduled_time) {
          return sendJSON({ error: 'purchase_id and scheduled_time required' }, 400);
        }
        
        const purchase = await db.prepare('SELECT * FROM purchases WHERE id=?').bind(b.purchase_id).first();
        if (!purchase) return sendJSON({ error: 'Purchase not found' }, 404);
        
        if (String(purchase.seller_id) !== String(user.id) && String(user.role).toLowerCase() !== 'admin') {
          return sendJSON({ error: 'Only the seller can schedule delivery' }, 403);
        }
        
        if (purchase.delivery_status !== 'awaiting') {
          return sendJSON({ error: 'This order is not awaiting delivery' }, 400);
        }
        
        // Seller can schedule up to 30 min before buyer's requested time
        // For express: within 5 min of purchase
        const cleanTime = String(b.scheduled_time).replace(/[<>&'"`]/g, '').trim().slice(0, 30);
        const notes = String(b.seller_notes || '').replace(/[<>&'"`]/g, '').trim().slice(0, 500);
        
        await db.prepare(
          `UPDATE purchases SET seller_scheduled_at=?, seller_notes=?, updated_at=datetime('now') WHERE id=?`
        ).bind(cleanTime, notes || null, b.purchase_id).run();
        
        return sendJSON({ message: 'Delivery scheduled', purchase_id: b.purchase_id, scheduled_at: cleanTime });
      }

      /* ================= SELLER: CONFIRM DELIVERY ================= */
      if (path === '/api/purchases/confirm-delivery' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) { return sendJSON({ error: 'Unauthorized' }, 401); }
        if (!rate(`confirm:${user.id}`, 20, 60000)) return sendJSON({ error: 'Too many requests' }, 429);
        
        const b = await request.json().catch(() => ({}));
        if (!b.purchase_id) return sendJSON({ error: 'purchase_id required' }, 400);
        
        const purchase = await db.prepare('SELECT * FROM purchases WHERE id=?').bind(b.purchase_id).first();
        if (!purchase) return sendJSON({ error: 'Purchase not found' }, 404);
        
        if (String(purchase.seller_id) !== String(user.id) && String(user.role).toLowerCase() !== 'admin') {
          return sendJSON({ error: 'Only the seller can confirm delivery' }, 403);
        }
        
        if (purchase.delivery_status !== 'awaiting') {
          return sendJSON({ error: 'Order not in awaiting state' }, 400);
        }
        
        await db.prepare(
          `UPDATE purchases SET delivery_status='delivered', payment_status='paid', delivered_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
        ).bind(b.purchase_id).run();
        
        return sendJSON({ message: 'Delivery confirmed', purchase_id: b.purchase_id });
      }

      /* ================= PURCHASE (create) ================= */
      if (path === '/api/purchases' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate(`buy:${user.id}`, 10, 60000)) {
          return sendJSON({ error: 'Too many purchase attempts. Try later.' }, 429);
        }

        const b = await request.json().catch(() => ({}));
        if (!b.listing_id) {return sendJSON({ error: 'listing_id required' }, 400);}

        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(b.listing_id).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}
        if (listing.status !== 'available') {return sendJSON({ error: 'Listing not available' }, 409);}
        if (String(listing.seller_id) === String(user.id)) {
          return sendJSON({ error: 'Cannot buy your own listing' }, 400);
        }

        // Buyer must ALWAYS provide the in-game UID where delivery should happen
        let targetUid = String(b.target_uid || '').replace(/[^0-9]/g, '').slice(0, 12);
        if (!/^[0-9]{6,12}$/.test(targetUid)) {
          return sendJSON({ error: 'Valid target_uid required (your BGMI UID for delivery)' }, 400);
        }

        const expressCharge = (b.express_delivery && listing.express_enabled) ? (Number(listing.express_charge) || 0) : 0;
        const finalPrice = Number(listing.price || 0) + expressCharge;
        if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
          return sendJSON({ error: 'Invalid listing price' }, 400);
        }

        const insert = await db.prepare(
          `INSERT INTO purchases (listing_id, buyer_id, seller_id, price, payment_status, delivery_status, delivery_date, delivery_time, target_uid, item_selections, express_delivery, created_at, updated_at)
           VALUES (?,?,?,?,'pending','awaiting',?,?,?,?,?, datetime('now'),datetime('now'))`
        ).bind(
          b.listing_id,
          String(user.id),
          String(listing.seller_id),
          finalPrice,
          String(b.delivery_date || '').replace(/[<>&'"`]/g, '').trim().slice(0, 20) || null,
          String(b.delivery_time || '').replace(/[<>&'"`]/g, '').trim().slice(0, 60) || null,
          targetUid || null,
          b.item_selections ? JSON.stringify(b.item_selections) : null,
          b.express_delivery ? 1 : 0
        ).run();
        const purchaseId = insert.meta?.last_row_id ?? insert.lastInsertRowid;

        // Popularity listing purchased â†’ credit buyer's popularity points
        if (listing.category === 'popularity' && listing.points > 0) {
          await db.prepare(
            `INSERT INTO popularity (user_id, points, source, created_at)
             VALUES (?, ?, 'purchase', datetime('now'))`
          ).bind(String(user.id), listing.points).run();
        }

        // Ensure seller row exists so commission UPDATE doesn't silently fail
        await ensureSeller(String(listing.seller_id));

        // 2.5% commission accrues to seller on every sale
        const commission = Math.round(Number(finalPrice || 0) * 0.025 * 100) / 100;
        if (commission > 0) {
          await db.prepare(
            `UPDATE sellers SET pending_commission = COALESCE(pending_commission,0) + ?,
                    total_sales = COALESCE(total_sales,0) + 1, total_revenue = COALESCE(total_revenue,0) + ?,
                    updated_at = datetime('now')
             WHERE CAST(user_id AS TEXT)=?`
          ).bind(commission, Number(finalPrice || 0), String(listing.seller_id)).run();
          await db.prepare(
            `INSERT INTO transaction_logs (purchase_id, buyer_id, seller_id, amount, type, source_service, note, created_at)
             VALUES (?,?,?,?,?,?,?,datetime('now'))`
          ).bind(purchaseId, String(user.id), String(listing.seller_id), commission, 'debit', 'marketplace', '2.5% seller commission').run();
        }

        return sendJSON({
          message: 'Purchase created',
          purchase: {
            id: purchaseId,
            listing_id: b.listing_id,
            seller_id: String(listing.seller_id),
            price: finalPrice
          }
        });
      }

      /* ================= MY PURCHASES ================= */
      if (path === '/api/purchases/my' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const { results } = await db.prepare(
          `SELECT p.*, l.title, l.uid
           FROM purchases p LEFT JOIN listings l ON l.id=p.listing_id
           WHERE p.buyer_id=? OR p.seller_id=?
           ORDER BY p.created_at DESC`
        ).bind(String(user.id), String(user.id)).all();

        return sendJSON(results || []);
      }

      /* ================= PUBLIC: SELLER REVIEWS ================= */
      if (path === '/api/reviews' && method === 'GET') {
        const sellerId = url.searchParams.get('seller_id');
        if (!sellerId) {return sendJSON({ error: 'seller_id required' }, 400);}
        const { results } = await db.prepare(
          `SELECT r.id, r.stars, r.comment, r.created_at, u.username AS buyer_name
           FROM reviews r LEFT JOIN users u ON CAST(u.id AS TEXT)=CAST(r.buyer_id AS TEXT)
           WHERE CAST(r.seller_id AS TEXT)=?
           ORDER BY r.created_at DESC LIMIT 50`
        ).bind(sellerId).all();
        const agg = await db.prepare(
          'SELECT AVG(stars) AS avg_rating, COUNT(*) AS total FROM reviews WHERE CAST(seller_id AS TEXT)=?'
        ).bind(sellerId).first();
        return sendJSON({
          reviews: results || [],
          avg_rating: Number(agg?.avg_rating || 0).toFixed(1),
          total_reviews: agg?.total || 0
        });
      }

      /* ================= CREATE REVIEW ================= */
      if (path === '/api/reviews' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate('review:' + user.id, 10, 60000)) return sendJSON({ error: 'Too many reviews. Try later.' }, 429);

        const b = await request.json().catch(() => ({}));
        if (!b.listing_id || !b.stars) {return sendJSON({ error: 'listing_id & stars required' }, 400);}
        const stars = Number(b.stars);
        if (!stars || stars < 1 || stars > 5) {return sendJSON({ error: 'stars must be 1-5' }, 400);}

        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(b.listing_id).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}

        const purchase = await db.prepare(
          'SELECT * FROM purchases WHERE listing_id=? AND buyer_id=?'
        ).bind(b.listing_id, String(user.id)).first();
        if (!purchase) {return sendJSON({ error: 'Buy this listing before reviewing' }, 403);}

        const dup = await db.prepare(
          'SELECT * FROM reviews WHERE listing_id=? AND buyer_id=?'
        ).bind(b.listing_id, String(user.id)).first();
        if (dup) {return sendJSON({ error: 'Already reviewed' }, 409);}

        await db.prepare(
          `INSERT INTO reviews (listing_id, buyer_id, seller_id, stars, comment, created_at)
           VALUES (?,?,?,?,?,datetime('now'))`
        ).bind(b.listing_id, String(user.id), String(listing.seller_id), stars, b.comment || '').run();

        const agg = await db.prepare(
          'SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM reviews WHERE listing_id=?'
        ).bind(b.listing_id).first();
        await db.prepare(
          'UPDATE listings SET avg_rating=?, review_count=?, updated_at=datetime(\'now\') WHERE id=?'
        ).bind(Number(agg.avg || 0).toFixed(1), agg.cnt, b.listing_id).run();

        await ensureSeller(String(listing.seller_id));
        const sellerAgg = await db.prepare(
          'SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM reviews WHERE seller_id=?'
        ).bind(String(listing.seller_id)).first();
        await db.prepare(
          "UPDATE sellers SET stars=?, review_count=?, badge=CASE WHEN badge='new' AND ?>=3 THEN 'trusted' ELSE badge END WHERE CAST(user_id AS TEXT)=?"
        ).bind(Number(sellerAgg.avg || 0).toFixed(1), sellerAgg.cnt, sellerAgg.cnt, String(listing.seller_id)).run();

        return sendJSON({ message: 'Review submitted', rating: stars });
      }

      /* ================= MY POPULARITY ================= */
      if (path === '/api/popularity/me' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const total = await db.prepare(
          'SELECT COALESCE(SUM(points),0) AS total FROM popularity WHERE user_id=?'
        ).bind(String(user.id)).first();
        const history = await db.prepare(
          'SELECT id, points, source, created_at FROM popularity WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
        ).bind(String(user.id)).all();

        return sendJSON({ user_id: String(user.id), total: total?.total || 0, history: history.results || [] });
      }

      /* ================= POPULARITY LEADERBOARD ================= */
      if (path === '/api/popularity/leaderboard' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
        const { results } = await db.prepare(`
          SELECT p.user_id, SUM(p.points) AS total_points,
                 COUNT(DISTINCT p.id) AS boosts
          FROM popularity p
          GROUP BY p.user_id
          ORDER BY total_points DESC
          LIMIT ?
        `).bind(limit).all();

        return sendJSON((results || []).map((r, i) => ({
          rank: i + 1,
          user_id: r.user_id,
          total_points: Number(r.total_points || 0),
          boosts: Number(r.boosts || 0)
        })));
      }

      /* ================= SELLER VERIFICATION ================= */
      if (path === '/api/seller/verify-request' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate(`verify:${user.id}`, 1, 60000)) {
          return sendJSON({ error: 'Too many requests. Try later.' }, 429);
        }
        await ensureSeller(user.id);

        const existing = await db.prepare(
          "SELECT id, status, badge FROM seller_verifications WHERE user_id=? AND status='pending' LIMIT 1"
        ).bind(String(user.id)).first();
        if (existing) {
          return sendJSON({ message: 'Request already pending', request: existing, already_pending: true });
        }

        const badge = 'trusted';
        const insert = await db.prepare(
          `INSERT INTO seller_verifications (user_id, status, badge, created_at)
           VALUES (?, 'pending', ?, datetime('now'))`
        ).bind(String(user.id), badge).run();

        return sendJSON({ message: 'Verification request submitted', id: insert.meta?.last_row_id ?? insert.lastInsertRowid, badge });
      }

      /* ================= ADMIN: VERIFICATION QUEUE ================= */
      if (path === '/api/admin/seller-verifications' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const status = url.searchParams.get('status') || '';
        let q = 'SELECT * FROM seller_verifications';
        const binds = [];
        if (status) { q += ' WHERE status=?'; binds.push(status); }
        q += ' ORDER BY created_at DESC LIMIT 200';
        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results || []);
      }

      /* ================= ADMIN: VERIFY DECISION ================= */
      if (path.startsWith('/api/admin/seller-verifications/') && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const id = Number(path.split('/').pop());
        if (!Number.isFinite(id) || id < 1) return sendJSON({ error: 'Invalid ID' }, 400);
        const b = await request.json().catch(() => ({}));
        const action = b.action || b.decision; // approve / reject
        if (!['approve', 'reject'].includes(action)) {
          return sendJSON({ error: 'Invalid action' }, 400);
        }

        const req = await db.prepare('SELECT * FROM seller_verifications WHERE id=?').bind(id).first();
        if (!req) {return sendJSON({ error: 'Request not found' }, 404);}
        if (req.status !== 'pending') {return sendJSON({ error: 'Already reviewed' }, 409);}

        const finalStatus = action === 'approve' ? 'approved' : 'rejected';

        await db.prepare(
          'UPDATE seller_verifications SET status=?, reason=?, reviewed_by=?, reviewed_at=datetime(\'now\') WHERE id=?'
        ).bind(finalStatus, b.reason || '', String(user.id), id).run();

        if (action === 'approve') {
          const badge = b.badge || req.badge || 'trusted';
          await db.prepare(
            `UPDATE sellers SET badge=?, status='active', updated_at=datetime('now')
             WHERE CAST(user_id AS TEXT)=?`
          ).bind(badge, String(req.user_id)).run();

          const seller = await db.prepare(
            'SELECT * FROM sellers WHERE CAST(user_id AS TEXT)=?'
          ).bind(String(req.user_id)).first();
          if (!seller) {
            await db.prepare(
              "INSERT INTO sellers (user_id, stars, review_count, badge, status, total_sales, total_revenue) VALUES (?,0,0,?, 'active',0,0)"
            ).bind(String(req.user_id), badge).run();
          }
        }

        return sendJSON({ message: `Verification ${finalStatus}`, id });
      }

      /* ================= ADMIN: ALL LISTINGS ================= */
      if (path === '/api/admin/listings' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const status = url.searchParams.get('status') || '';
        let q = 'SELECT l.*, u.username AS seller_name FROM listings l LEFT JOIN users u ON CAST(u.id AS TEXT)=l.seller_id';
        const binds = [];
        q += ' WHERE l.deleted_at IS NULL';
        if (status) { q += ' AND l.status=?'; binds.push(status); }
        q += ' ORDER BY l.created_at DESC LIMIT 200';

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results.map(normalize));
      }

      /* ================= ADMIN: MODERATE LISTING ================= */
      if (path.startsWith('/api/admin/listings/') && method === 'PATCH') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const listingId = path.split('/')[4];
        const b = await request.json().catch(() => ({}));

        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(listingId).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}

        const updates = [];
        const binds = [];

        if (b.status !== undefined) {
          const status = b.status;
          if (!['available', 'pending', 'hidden', 'sold'].includes(status)) {
            return sendJSON({ error: 'Invalid status' }, 400);
          }
          updates.push('status=?');
          binds.push(status);
        }

        if (b.price !== undefined) {
          const price = Number(b.price);
          if (!isFinite(price) || price <= 0 || price > 100000000) {
            return sendJSON({ error: 'Invalid price' }, 400);
          }
          updates.push('price=?');
          binds.push(price);
        }

        if (!updates.length) {return sendJSON({ error: 'Nothing to update' }, 400);}

        binds.push(listingId);
        await db.prepare(
          `UPDATE listings SET ${updates.join(', ')}, updated_at=datetime('now') WHERE id=?`
        ).bind(...binds).run();

        if (b.status !== undefined) {
          await db.prepare(
            `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, created_at)
             VALUES (?,?,?,?,datetime('now'))`
          ).bind(String(user.id), `moderate_${b.status}`, String(listingId), b.reason || '').run();
        }

        return sendJSON({ message: 'Listing updated', id: listingId, status: b.status, price: b.price });
      }

      /* ================= SELLER PROFILE UPDATE (city / meetup) ================= */
      if (path === '/api/seller/profile' && method === 'PUT') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        await ensureSeller(user.id);

        const b = await request.json().catch(() => ({}));
        const city = cleanVal(b.city, 40);
        const meetupNote = cleanVal(b.meetup_note, 120);

        await db.prepare(
          `UPDATE sellers SET city=COALESCE(?, city), meetup_note=COALESCE(?, meetup_note), updated_at=datetime('now')
           WHERE CAST(user_id AS TEXT)=?`
        ).bind(city || null, meetupNote || null, String(user.id)).run();

        return sendJSON({ message: 'Seller profile updated', city: city || null, meetup_note: meetupNote || null });
      }

      /* ================= SELLERS DIRECTORY (city-wise search) ================= */
      if (path === '/api/sellers' && method === 'GET') {
        const city = cleanVal(url.searchParams.get('city'), 40);
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
        let q = `
          SELECT s.user_id, s.stars, s.review_count, s.badge, s.status, s.total_sales, s.total_revenue,
                 s.city, s.meetup_note,
                 (SELECT COUNT(*) FROM listings l
                  WHERE CAST(l.seller_id AS TEXT)=CAST(s.user_id AS TEXT) AND l.status='available') AS active_listings
          FROM sellers s WHERE s.status='active'`;
        const binds = [];
        if (city) { q += ' AND s.city LIKE ?'; binds.push(`%${city}%`); }
        q += ' ORDER BY s.total_sales DESC, s.stars DESC LIMIT ?';
        binds.push(limit);

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON((results || []).map(r => ({
          ...r,
          avg_rating: Number(r.stars || 0).toFixed(1),
          seller_verified: r.badge !== 'new'
        })));
      }

      /* ================= MEETUP: CREATE REQUEST ================= */
      if (path === '/api/meetups' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate(`meetup:${user.id}`, 5, 60000)) {
          return sendJSON({ error: 'Too many meetup requests. Try later.' }, 429);
        }

        const b = await request.json().catch(() => ({}));
        if (!b.listing_id) {return sendJSON({ error: 'listing_id required' }, 400);}

        const listing = await db.prepare('SELECT * FROM listings WHERE id=? AND deleted_at IS NULL').bind(b.listing_id).first();
        if (!listing) {return sendJSON({ error: 'Listing not found' }, 404);}
        if (listing.status !== 'available') {return sendJSON({ error: 'Listing not available' }, 409);}
        if (String(listing.seller_id) === String(user.id)) {
          return sendJSON({ error: 'Cannot request meetup on your own listing' }, 400);
        }

        const city = cleanVal(b.city || listing.city, 40) || 'City not specified';
        const location = cleanVal(b.location, 120);
        const meetDate = cleanVal(b.meet_date, 20);
        const meetTime = cleanVal(b.meet_time, 20);
        const note = cleanVal(b.note, 300);
        if (!city || !location || !meetDate || !meetTime) {
          return sendJSON({ error: 'city, location, meet_date & meet_time required' }, 400);
        }

        const insert = await db.prepare(
          `INSERT INTO meetup_requests (listing_id, buyer_id, seller_id, city, location, meet_date, meet_time, note, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'pending',datetime('now'),datetime('now'))`
        ).bind(b.listing_id, String(user.id), String(listing.seller_id), city, location, meetDate, meetTime, note).run();

        return sendJSON({
          message: 'Meetup request sent',
          id: insert.meta?.last_row_id ?? insert.lastInsertRowid,
          status: 'pending'
        });
      }

      /* ================= MEETUP: MY REQUESTS ================= */
      if (path === '/api/meetups/my' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const { results } = await db.prepare(
          `SELECT m.*, l.title AS listing_title, l.uid AS listing_uid, l.price AS listing_price
           FROM meetup_requests m LEFT JOIN listings l ON l.id=m.listing_id
           WHERE m.buyer_id=? OR m.seller_id=?
           ORDER BY m.created_at DESC LIMIT 200`
        ).bind(String(user.id), String(user.id)).all();

        return sendJSON((results || []).map(r => ({
          ...r,
          is_buyer: String(r.buyer_id) === String(user.id),
          is_seller: String(r.seller_id) === String(user.id)
        })));
      }

      /* ================= MEETUP: RESPOND (seller approve/decline) ================= */
      if (path.startsWith('/api/meetups/') && method === 'POST') {
        const parts = path.split('/');
        if (parts.length < 5) {return sendJSON({ error: 'Invalid path' }, 400);}
        const id = Number(parts[3]);
        if (!Number.isFinite(id) || id < 1) return sendJSON({ error: 'Invalid ID' }, 400);
        const action = parts[4]; // respond / complete

        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}

        const req = await db.prepare('SELECT * FROM meetup_requests WHERE id=?').bind(id).first();
        if (!req) {return sendJSON({ error: 'Meetup request not found' }, 404);}

        if (action === 'respond') {
          if (String(req.seller_id) !== String(user.id) && String(user.role).toLowerCase() !== 'admin') {
            return sendJSON({ error: 'Forbidden' }, 403);
          }
          const b = await request.json().catch(() => ({}));
          const decision = b.decision === 'approved' ? 'approved' : (b.decision === 'declined' ? 'declined' : null);
          if (!decision) {return sendJSON({ error: 'decision must be approved or declined' }, 400);}
          if (req.status !== 'pending') {return sendJSON({ error: 'Already responded' }, 409);}

          await db.prepare(
            "UPDATE meetup_requests SET status=?, updated_at=datetime('now') WHERE id=?"
          ).bind(decision, id).run();
          return sendJSON({ message: `Meetup ${decision}`, id });
        }

        if (action === 'complete') {
          if (![String(req.buyer_id), String(req.seller_id)].includes(String(user.id))
              && String(user.role).toLowerCase() !== 'admin') {
            return sendJSON({ error: 'Forbidden' }, 403);
          }
          if (req.status !== 'approved') {return sendJSON({ error: 'Only approved meetups can be completed' }, 409);}
          await db.prepare(
            "UPDATE meetup_requests SET status='completed', updated_at=datetime('now') WHERE id=?"
          ).bind(id).run();
          return sendJSON({ message: 'Meetup marked completed', id });
        }

        return sendJSON({ error: 'Invalid action' }, 400);
      }

      /* ================= ADMIN: ALL MEETUPS ================= */
      if (path === '/api/admin/meetups' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const status = url.searchParams.get('status') || '';
        let q = 'SELECT m.*, l.title AS listing_title FROM meetup_requests m LEFT JOIN listings l ON l.id=m.listing_id';
        const binds = [];
        if (status) { q += ' WHERE m.status=?'; binds.push(status); }
        q += ' ORDER BY m.created_at DESC LIMIT 200';

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results || []);
      }

      /* ================= SELLER: COMMISSION STATUS ================= */
      if (path === '/api/commission/me' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        await ensureSeller(user.id);

        const seller = await db.prepare(
          'SELECT pending_commission, hidden FROM sellers WHERE CAST(user_id AS TEXT)=?'
        ).bind(String(user.id)).first();
        const { results: payments } = await db.prepare(
          `SELECT id, amount, status, utr, note, created_at, reviewed_at
           FROM commission_payments WHERE seller_id=? ORDER BY created_at DESC LIMIT 50`
        ).bind(String(user.id)).all();

        return sendJSON({
          pending_commission: Number(seller?.pending_commission || 0),
          hidden: Number(seller?.hidden || 0),
          payments: payments || []
        });
      }

      /* ================= SELLER: PAY COMMISSION ================= */
      if (path === '/api/commission/pay' && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user) {return sendJSON({ error: 'Unauthorized' }, 401);}
        if (!rate(`comm:${user.id}`, 10, 60000)) return sendJSON({ error: 'Too many requests' }, 429);
        await ensureSeller(user.id);

        const seller = await db.prepare(
          'SELECT pending_commission FROM sellers WHERE CAST(user_id AS TEXT)=?'
        ).bind(String(user.id)).first();
        const balance = Number(seller?.pending_commission || 0);
        if (balance <= 0) {return sendJSON({ error: 'No pending commission to pay' }, 400);}

        const b = await request.json().catch(() => ({}));
        const amount = Math.round(Number(b.amount) * 100) / 100;
        const utr = cleanVal(b.utr, 60);
        if (!Number.isFinite(amount) || amount <= 0 || amount > balance) {
          return sendJSON({ error: `Amount must be between 0 and ${balance}` }, 400);
        }
        if (!utr) {return sendJSON({ error: 'UTR number required' }, 400);}

        const insert = await db.prepare(
          `INSERT INTO commission_payments (seller_id, amount, status, utr, note, created_at)
           VALUES (?,?, 'submitted', ?, ?, datetime('now'))`
        ).bind(String(user.id), amount, utr, cleanVal(b.note, 200) || '').run();

        return sendJSON({
          message: 'Commission payment submitted',
          id: insert.meta?.last_row_id ?? insert.lastInsertRowid,
          amount,
          status: 'submitted'
        });
      }

      /* ================= ADMIN: COMMISSIONS ================= */
      if (path === '/api/admin/commissions' && method === 'GET') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const { results: sellers } = await db.prepare(
          `SELECT user_id, pending_commission, hidden, total_sales, total_revenue, badge
           FROM sellers WHERE COALESCE(pending_commission,0) > 0 OR hidden=1
           ORDER BY COALESCE(pending_commission,0) DESC LIMIT 200`
        ).all();
        const { results: payments } = await db.prepare(
          `SELECT cp.*, s.pending_commission AS seller_balance
           FROM commission_payments cp LEFT JOIN sellers s ON CAST(s.user_id AS TEXT)=cp.seller_id
           ORDER BY cp.created_at DESC LIMIT 200`
        ).all();

        return sendJSON({ sellers: sellers || [], payments: payments || [] });
      }

      /* ================= ADMIN: COMMISSION DECISION ================= */
      if (path.startsWith('/api/admin/commissions/') && method === 'POST') {
        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const id = Number(path.split('/').pop());
        if (!Number.isFinite(id) || id < 1) return sendJSON({ error: 'Invalid ID' }, 400);
        const b = await request.json().catch(() => ({}));
        const action = b.action; // approve / reject
        if (!['approve', 'reject'].includes(action)) {return sendJSON({ error: 'Invalid action' }, 400);}

        const payment = await db.prepare('SELECT * FROM commission_payments WHERE id=?').bind(id).first();
        if (!payment) {return sendJSON({ error: 'Payment not found' }, 404);}
        if (payment.status !== 'submitted') {return sendJSON({ error: 'Already reviewed' }, 409);}

        const finalStatus = action === 'approve' ? 'paid' : 'rejected';
        await db.prepare(
          'UPDATE commission_payments SET status=?, note=COALESCE(?, note), reviewed_by=?, reviewed_at=datetime(\'now\') WHERE id=?'
        ).bind(finalStatus, b.note || null, String(user.id), id).run();

        if (action === 'approve') {
          const bal = await db.prepare(
            'SELECT COALESCE(pending_commission,0) AS bc FROM sellers WHERE CAST(user_id AS TEXT)=?'
          ).bind(String(payment.seller_id)).first();
          const newBal = Math.max(0, Math.round((Number(bal?.bc || 0) - Number(payment.amount)) * 100) / 100);
          await db.prepare(
            `UPDATE sellers SET pending_commission=?, hidden=CASE WHEN ?<=0 THEN 0 ELSE hidden END, updated_at=datetime('now')
             WHERE CAST(user_id AS TEXT)=?`
          ).bind(newBal, newBal, String(payment.seller_id)).run();
        }

        return sendJSON({ message: `Commission payment ${finalStatus}`, id });
      }

      /* ================= ADMIN: HIDE / UNHIDE SELLER ================= */
      if (path.startsWith('/api/admin/sellers/') && method === 'POST') {
        const parts = path.split('/');
        // [ '', 'api', 'admin', 'sellers', <sellerId>, <action> ]
        if (parts.length < 6) {return sendJSON({ error: 'Invalid path' }, 400);}
        const sellerId = String(decodeURIComponent(parts[4] || ''));
        const action = parts[5] || ''; // hide / unhide

        const user = await verifyJWT(request);
        if (!user || user.role !== 'admin') {return sendJSON({ error: 'Admin only' }, 403);}

        const b = await request.json().catch(() => ({}));

        // badge action: set seller badge (professional tiers)
        if (action === 'badge') {
          const allowedBadges = ['new', 'verified', 'veteran', 'trusted', 'elite', 'gold', 'diamond', 'secure'];
          if (!allowedBadges.includes(b.badge)) {return sendJSON({ error: 'Invalid badge. Allowed: ' + allowedBadges.join(', ') }, 400);}
          await db.prepare(
            'UPDATE sellers SET badge=?, updated_at=datetime(\'now\') WHERE CAST(user_id AS TEXT)=?'
          ).bind(b.badge, sellerId).run();
          return sendJSON({ message: `Badge set to ${b.badge}`, seller_id: sellerId, badge: b.badge });
        }

        if (!['hide', 'unhide'].includes(action)) {return sendJSON({ error: 'Invalid action' }, 400);}

        const seller = await db.prepare('SELECT * FROM sellers WHERE CAST(user_id AS TEXT)=?').bind(sellerId).first();
        if (!seller) {return sendJSON({ error: 'Seller not found' }, 404);}

        const hidden = action === 'hide' ? 1 : 0;
        await db.prepare(
          'UPDATE sellers SET hidden=?, updated_at=datetime(\'now\') WHERE CAST(user_id AS TEXT)=?'
        ).bind(hidden, sellerId).run();

        await db.prepare(
          `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, created_at)
           VALUES (?,?,?,?,datetime('now'))`
        ).bind(String(user.id), `seller_${action}`, sellerId, cleanVal(b.reason, 300) || '').run();

        return sendJSON({ message: `Seller ${action}`, user_id: sellerId, hidden });
      }

    } catch (err) {
      console.error('server error:', err);
      return sendJSON({ error: 'Server error' }, 500);
    }

    return sendJSON({ error: 'Not found' }, 404);
  }
};
