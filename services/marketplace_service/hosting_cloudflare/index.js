/**
 * =====================================================
 * 🛒 BGMI Marketplace Service v4.0.0
 * =====================================================
 * ✅ Listings CRUD + single listing GET
 * ✅ Reviews (create + seller aggregates)
 * ✅ Purchases (escrow tracking)
 * ✅ Admin moderation (list all, moderate status)
 * ✅ JWT Auth (shared secret)
 * =====================================================
 */

import jwt from "@tsndr/cloudflare-worker-jwt";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const db = env.marketplace_db;

    const SECURITY_HEADERS = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "X-XSS-Protection": "1; mode=block",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
    };

    const CORS_HEADERS = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      ...SECURITY_HEADERS
    };
    if (method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

    const sendJSON = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: CORS_HEADERS });

    const hits = new Map();
    const rate = (key, max, windowMs) => {
      const now = Date.now();
      const rec = hits.get(key);
      if (!rec || now - rec.t > windowMs) {
        hits.set(key, { t: now, n: 1 });
        return true;
      }
      if (rec.n >= max) return false;
      rec.n++;
      return true;
    };
    const cleanVal = (v, max) => String(v ?? "").replace(/[<>&'"`]/g, "").trim().slice(0, max);

    const safeJSON = (v, d = []) => {
      try { return JSON.parse(v || "[]"); } catch { return d; }
    };

    async function verifyJWT(req) {
      const auth = req.headers.get("Authorization");
      if (!auth) return null;
      const token = auth.split(" ")[1];
      if (!(await jwt.verify(token, env.JWT_SECRET))) return null;
      const { payload } = jwt.decode(token);
      if (!payload) return null;
      const { results } = await db.prepare(
        "SELECT role FROM users WHERE id=?"
      ).bind(String(payload.id)).all();
      if (results.length) payload.role = results[0].role;
      return payload;
    }

    async function ensureSeller(userId) {
      const sid = String(userId);
      const s = await db.prepare("SELECT * FROM sellers WHERE CAST(user_id AS TEXT)=?")
        .bind(sid).first();
      if (!s) {
        await db.prepare(
          "INSERT INTO sellers (user_id, stars, review_count, badge, status, total_sales, total_revenue) VALUES (?,0,0,'new','active',0,0)"
        ).bind(sid).run();
      }
    }

    const normalize = r => ({
      ...r,
      mythic_items: safeJSON(r.mythic_items),
      legendary_items: safeJSON(r.legendary_items),
      honor_gift: safeJSON(r.honor_gift ?? r.gift_items),
      upgraded_guns: safeJSON(r.upgraded_guns),
      titles: safeJSON(r.titles),
      x_suit: safeJSON(r.x_suit),
      supercar: safeJSON(r.supercar),
      ultimate: safeJSON(r.ultimate),
      images: safeJSON(r.images),
    });

    /* ================= HEALTH ================= */
    if (path === "/api/health") {
      return sendJSON({ service: "marketplace", version: "4.0.0", status: "running" });
    }

    try {
      /* ================= SELLER PROFILE ================= */
      if (path.startsWith("/api/seller/") && method === "GET") {
        const parts = path.split("/");
        const sellerId = String(decodeURIComponent(parts[3] || ""));
        const seller = await db.prepare(
          `SELECT user_id, stars, review_count, badge, status, total_sales, total_revenue
           FROM sellers WHERE CAST(user_id AS TEXT)=?`
        ).bind(sellerId).first();

        if (!seller) return sendJSON({ error: "Seller not found" }, 404);

        const listings = await db.prepare(
          "SELECT * FROM listings WHERE CAST(seller_id AS TEXT)=? AND status='available'"
        ).bind(sellerId).all();

        const reviews = await db.prepare(
          `SELECT id, buyer_id, stars, comment, reply, created_at
           FROM reviews WHERE CAST(seller_id AS TEXT)=?
           ORDER BY created_at DESC LIMIT 20`
        ).bind(sellerId).all();

        return sendJSON({
          user_id: seller.user_id,
          name: `Seller ${seller.user_id}`,
          avg_rating: Number(seller.stars || 0).toFixed(1),
          review_count: seller.review_count || 0,
          seller_verified: seller.badge !== "new",
          badge: seller.badge,
          total_sales: seller.total_sales,
          total_revenue: seller.total_revenue,
          listings: listings.results.map(normalize),
          reviews: reviews.results
        });
      }

      /* ================= GET LISTINGS ================= */
      if (path === "/api/listings" && method === "GET") {
        let q = "SELECT * FROM listings WHERE status='available'";
        const binds = [];
        const search = url.searchParams.get("q");
        const filter = url.searchParams.get("filter");
        const user = await verifyJWT(request);

        if (search) {
          q += " AND (title LIKE ? OR uid LIKE ? OR highest_rank LIKE ?)";
          binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (filter === "own" && user) {
          q += " AND CAST(seller_id AS TEXT)=?";
          binds.push(String(user.seller_id || user.id));
        }

        if (filter === "price_high") q += " ORDER BY price DESC";
        else if (filter === "price_low") q += " ORDER BY price ASC";
        else q += " ORDER BY created_at DESC";

        const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
        const offset = Number(url.searchParams.get("offset") || 0);
        q += " LIMIT ? OFFSET ?";
        binds.push(limit, offset);

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results.map(normalize));
      }

      /* ================= GET SINGLE LISTING ================= */
      if (path.startsWith("/api/listings/") && method === "GET" && !path.includes("/create")) {
        const listingId = Number(path.split("/")[3]);
        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(listingId).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);
        return sendJSON(normalize(listing));
      }

      /* ================= CREATE LISTING ================= */
      if (path === "/api/listings/create" && method === "POST") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);
        if (!rate(`create:${user.id}`, 5, 60000)) {
          return sendJSON({ error: "Too many listings. Try later." }, 429);
        }
        await ensureSeller(user.id);

        const b = await request.json();
        if (!b.uid || !b.title || !b.price) {
          return sendJSON({ error: "uid, title & price required" }, 400);
        }

        const cleanUid = String(b.uid).replace(/[^0-9]/g, "").slice(0, 12);
        if (!/^[0-9]{1,12}$/.test(cleanUid)) return sendJSON({ error: "Invalid UID" }, 400);
        const cleanTitle = String(b.title).replace(/[<>&'"`]/g, "").trim().slice(0, 80);
        if (!cleanTitle) return sendJSON({ error: "Title required" }, 400);
        const price = Number(b.price);
        if (!Number.isFinite(price) || price < 1 || price > 10000000) {
          return sendJSON({ error: "Price must be between ₹1 and ₹10,000,000" }, 400);
        }
        const cleanDesc = String(b.description || "").replace(/[<>&'"`]/g, "").trim().slice(0, 1000);

        const insert = await db.prepare(
          `INSERT INTO listings
          (seller_id,uid,title,description,price,level,highest_rank,
           mythic_items,legendary_items,honor_gift,upgraded_guns,titles,
           x_suit,supercar,ultimate,images,
           status,avg_rating,review_count,seller_verified)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'available',0,0,0)`
        ).bind(
          String(user.id),
          cleanUid,
          cleanTitle,
          cleanDesc,
          price,
          b.level || 0,
          b.highest_rank || "",
          JSON.stringify(b.mythic_items || []),
          JSON.stringify(b.legendary_items || []),
          JSON.stringify(b.honor_gift ?? (b.gift_items || [])),
          JSON.stringify(b.upgraded_guns || []),
          JSON.stringify(b.titles || []),
          JSON.stringify(b.x_suit || []),
          JSON.stringify(b.supercar || []),
          JSON.stringify(b.ultimate || []),
          JSON.stringify(b.images || [])
        ).run();

        return sendJSON({ message: "Listing created", id: insert.meta?.last_row_id ?? insert.lastInsertRowid });
      }

      /* ================= EDIT LISTING ================= */
      if (path.startsWith("/api/listings/") && method === "PUT") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const listingId = path.split("/")[3];
        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(listingId).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        if (String(listing.seller_id) !== String(user.seller_id || user.id)
            && String(user.role).toLowerCase() !== "admin") {
          return sendJSON({ error: "Forbidden" }, 403);
        }

        const b = await request.json();
        const price = Number(b.price);
        if (b.price !== undefined && (!Number.isFinite(price) || price < 1 || price > 10000000)) {
          return sendJSON({ error: "Price must be between ₹1 and ₹10,000,000" }, 400);
        }
        const cleanTitle = b.title !== undefined ? cleanVal(b.title, 80) : undefined;
        if (b.title !== undefined && !cleanTitle) return sendJSON({ error: "Title required" }, 400);
        const cleanDesc = b.description !== undefined ? cleanVal(b.description, 1000) : undefined;
        await db.prepare(
          `UPDATE listings SET
            title=?, description=?, price=?, level=?, highest_rank=?,
            mythic_items=?, legendary_items=?, honor_gift=?, upgraded_guns=?, titles=?,
            x_suit=?, supercar=?, ultimate=?, images=?,
            updated_at=datetime('now')
           WHERE id=?`
        ).bind(
          cleanTitle ?? b.title,
          (cleanDesc ?? b.description) || "",
          price || b.price || 0,
          b.level || 0,
          b.highest_rank || "",
          JSON.stringify(b.mythic_items || []),
          JSON.stringify(b.legendary_items || []),
          JSON.stringify(b.honor_gift ?? (b.gift_items || [])),
          JSON.stringify(b.upgraded_guns || []),
          JSON.stringify(b.titles || []),
          JSON.stringify(b.x_suit || []),
          JSON.stringify(b.supercar || []),
          JSON.stringify(b.ultimate || []),
          JSON.stringify(b.images || []),
          listingId
        ).run();

        return sendJSON({ message: "Listing updated" });
      }

      /* ================= DELETE LISTING ================= */
      if (path.startsWith("/api/listings/") && method === "DELETE") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const listingId = path.split("/")[3];
        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(listingId).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        if (String(listing.seller_id) !== String(user.seller_id || user.id)
            && String(user.role).toLowerCase() !== "admin") {
          return sendJSON({ error: "Forbidden" }, 403);
        }

        await db.prepare("DELETE FROM listings WHERE id=?").bind(listingId).run();
        return sendJSON({ message: "Listing deleted" });
      }

      /* ================= PURCHASE (create) ================= */
      if (path === "/api/purchases" && method === "POST") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const b = await request.json();
        if (!b.listing_id) return sendJSON({ error: "listing_id required" }, 400);

        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(b.listing_id).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);
        if (listing.status !== "available") return sendJSON({ error: "Listing not available" }, 409);
        if (String(listing.seller_id) === String(user.id)) {
          return sendJSON({ error: "Cannot buy your own listing" }, 400);
        }

        const insert = await db.prepare(
          `INSERT INTO purchases (listing_id, buyer_id, seller_id, price, payment_status, delivery_status, created_at, updated_at)
           VALUES (?,?,?,?,'pending','awaiting',datetime('now'),datetime('now'))`
        ).bind(b.listing_id, String(user.id), String(listing.seller_id), listing.price).run();

        return sendJSON({
          message: "Purchase created",
          purchase: {
            id: insert.meta?.last_row_id ?? insert.lastInsertRowid,
            listing_id: b.listing_id,
            seller_id: String(listing.seller_id),
            price: listing.price
          }
        });
      }

      /* ================= MY PURCHASES ================= */
      if (path === "/api/purchases/my" && method === "GET") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const { results } = await db.prepare(
          `SELECT p.*, l.title, l.uid
           FROM purchases p LEFT JOIN listings l ON l.id=p.listing_id
           WHERE p.buyer_id=? OR p.seller_id=?
           ORDER BY p.created_at DESC`
        ).bind(String(user.id), String(user.id)).all();

        return sendJSON(results || []);
      }

      /* ================= CREATE REVIEW ================= */
      if (path === "/api/reviews" && method === "POST") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const b = await request.json();
        if (!b.listing_id || !b.stars) return sendJSON({ error: "listing_id & stars required" }, 400);
        const stars = Number(b.stars);
        if (!stars || stars < 1 || stars > 5) return sendJSON({ error: "stars must be 1-5" }, 400);

        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(b.listing_id).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        const purchase = await db.prepare(
          `SELECT * FROM purchases WHERE listing_id=? AND buyer_id=?`
        ).bind(b.listing_id, String(user.id)).first();
        if (!purchase) return sendJSON({ error: "Buy this listing before reviewing" }, 403);

        const dup = await db.prepare(
          "SELECT * FROM reviews WHERE listing_id=? AND buyer_id=?"
        ).bind(b.listing_id, String(user.id)).first();
        if (dup) return sendJSON({ error: "Already reviewed" }, 409);

        await db.prepare(
          `INSERT INTO reviews (listing_id, buyer_id, seller_id, stars, comment, created_at)
           VALUES (?,?,?,?,?,datetime('now'))`
        ).bind(b.listing_id, String(user.id), String(listing.seller_id), stars, b.comment || "").run();

        const agg = await db.prepare(
          `SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM reviews WHERE listing_id=?`
        ).bind(b.listing_id).first();
        await db.prepare(
          `UPDATE listings SET avg_rating=?, review_count=?, updated_at=datetime('now') WHERE id=?`
        ).bind(Number(agg.avg || 0).toFixed(1), agg.cnt, b.listing_id).run();

        const sellerAgg = await db.prepare(
          `SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM reviews WHERE seller_id=?`
        ).bind(String(listing.seller_id)).first();
        await db.prepare(
          `UPDATE sellers SET stars=?, review_count=?, badge=CASE WHEN ?>=3 THEN 'trusted' ELSE 'new' END WHERE CAST(user_id AS TEXT)=?`
        ).bind(Number(sellerAgg.avg || 0).toFixed(1), sellerAgg.cnt, sellerAgg.cnt, String(listing.seller_id)).run();

        return sendJSON({ message: "Review submitted", rating: stars });
      }

      /* ================= ADMIN: ALL LISTINGS ================= */
      if (path === "/api/admin/listings" && method === "GET") {
        const user = await verifyJWT(request);
        if (!user || user.role !== "admin") return sendJSON({ error: "Admin only" }, 403);

        const status = url.searchParams.get("status") || "";
        let q = "SELECT * FROM listings";
        const binds = [];
        if (status) { q += " WHERE status=?"; binds.push(status); }
        q += " ORDER BY created_at DESC LIMIT 200";

        const { results } = await db.prepare(q).bind(...binds).all();
        return sendJSON(results.map(normalize));
      }

      /* ================= ADMIN: MODERATE LISTING ================= */
      if (path.startsWith("/api/admin/listings/") && method === "PATCH") {
        const user = await verifyJWT(request);
        if (!user || user.role !== "admin") return sendJSON({ error: "Admin only" }, 403);

        const listingId = path.split("/")[4];
        const b = await request.json().catch(() => ({}));
        const status = b.status;
        if (!["available", "pending", "hidden", "sold"].includes(status)) {
          return sendJSON({ error: "Invalid status" }, 400);
        }

        const listing = await db.prepare("SELECT * FROM listings WHERE id=?").bind(listingId).first();
        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        await db.prepare(
          "UPDATE listings SET status=?, updated_at=datetime('now') WHERE id=?"
        ).bind(status, listingId).run();

        await db.prepare(
          `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, created_at)
           VALUES (?,?,?,?,datetime('now'))`
        ).bind(String(user.id), `moderate_${status}`, String(listingId), b.reason || "").run();

        return sendJSON({ message: "Listing moderated", id: listingId, status });
      }

    } catch (err) {
      console.error(err);
      return sendJSON({ error: "Server error", details: err.message }, 500);
    }

    return sendJSON({ error: "Not found" }, 404);
  }
};
