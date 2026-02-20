/**
 * =====================================================
 * 🛒 BGMI Marketplace Service v3.3 (FULLY FIXED)
 * =====================================================
 * ✅ Listings CRUD (Create, Read, Update, Delete)
 * ✅ Seller profile full info
 * ✅ My Listings filter + Admin rights
 * ✅ Images, gifts, mythic, legendary, guns, titles included
 * ✅ JWT Auth
 * =====================================================
 */

import jwt from "@tsndr/cloudflare-worker-jwt";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const db = env.marketplace_db;

    const CORS_HEADERS = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };
    if (method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

    const sendJSON = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: CORS_HEADERS });

    const safeJSON = (v, d = []) => {
      try { return JSON.parse(v || "[]"); } catch { return d; }
    };

    async function verifyJWT(req) {
      const auth = req.headers.get("Authorization");
      if (!auth) return null;
      const token = auth.split(" ")[1];
      if (!(await jwt.verify(token, env.JWT_SECRET))) return null;
      return jwt.decode(token).payload;
    }

    async function ensureSeller(userId) {
      const sid = String(userId);
      const s = await db.prepare("SELECT * FROM sellers WHERE CAST(user_id AS TEXT)=?")
        .bind(sid).first();
      if (!s) {
        await db.prepare(
          "INSERT INTO sellers (user_id, stars, badge, status, total_sales, total_revenue) VALUES (?,0,'new','active',0,0)"
        ).bind(sid).run();
      }
    }

    /* ================= HEALTH ================= */
    if (path === "/api/health") {
      return sendJSON({ service: "marketplace", version: "3.3.0", status: "running" });
    }

    try {
      /* ================= SELLER PROFILE ================= */
      if (path.startsWith("/api/seller/") && method === "GET") {
        const parts = path.split("/");
        const sellerId = String(decodeURIComponent(parts[3] || ""));
        const seller = await db.prepare(
          `SELECT user_id, stars, badge, status, total_sales, total_revenue
           FROM sellers WHERE CAST(user_id AS TEXT)=?`
        ).bind(sellerId).first();

        if (!seller) return sendJSON({ error: "Seller not found" }, 404);

        const listings = await db.prepare(
          "SELECT * FROM listings WHERE CAST(seller_id AS TEXT)=? AND status='available'"
        ).bind(sellerId).all();

        const reviews = await db.prepare(
          `SELECT r.id, r.stars, r.comment, r.reply, r.created_at
           FROM reviews r
           JOIN orders o ON o.id=r.order_id
           WHERE CAST(o.seller_id AS TEXT)=?
           ORDER BY r.created_at DESC
           LIMIT 20`
        ).bind(sellerId).all();

        return sendJSON({
          user_id: seller.user_id,
          name: `Seller ${seller.user_id}`,
          avg_rating: seller.stars || 0,
          review_count: reviews.results.length,
          seller_verified: seller.badge !== "new",
          total_sales: seller.total_sales,
          total_revenue: seller.total_revenue,
          listings: listings.results.map(r => ({
            ...r,
            mythic_items: safeJSON(r.mythic_items),
            legendary_items: safeJSON(r.legendary_items),
            gift_items: safeJSON(r.gift_items),
            upgraded_guns: safeJSON(r.upgraded_guns),
            titles: safeJSON(r.titles),
            images: safeJSON(r.images),
          })),
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

        const limit = Number(url.searchParams.get("limit") || 100);
        const offset = Number(url.searchParams.get("offset") || 0);
        q += " LIMIT ? OFFSET ?";
        binds.push(limit, offset);

        const { results } = await db.prepare(q).bind(...binds).all();

        const normalized = results.map(r => ({
          ...r,
          mythic_items: safeJSON(r.mythic_items),
          legendary_items: safeJSON(r.legendary_items),
          gift_items: safeJSON(r.gift_items),
          upgraded_guns: safeJSON(r.upgraded_guns),
          titles: safeJSON(r.titles),
          images: safeJSON(r.images),
        }));

        return sendJSON(normalized);
      }

      /* ================= CREATE LISTING ================= */
      if (path === "/api/listings/create" && method === "POST") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);
        await ensureSeller(user.id);

        const b = await request.json();
        await db.prepare(
          `INSERT INTO listings
          (seller_id,uid,title,description,price,level,highest_rank,
           mythic_items,legendary_items,gift_items,upgraded_guns,titles,images,
           status,avg_rating,review_count,seller_verified)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'available',0,0,0)`
        ).bind(
          String(user.id),
          b.uid,
          b.title,
          b.description || "",
          b.price || 0,
          b.level || 0,
          b.highest_rank || "",
          JSON.stringify(b.mythic_items || []),
          JSON.stringify(b.legendary_items || []),
          JSON.stringify(b.gift_items || []),
          JSON.stringify(b.upgraded_guns || []),
          JSON.stringify(b.titles || []),
          JSON.stringify(b.images || [])
        ).run();

        return sendJSON({ message: "Listing created" });
      }

      /* ================= EDIT LISTING ================= */
      if (path.startsWith("/api/listings/") && method === "PUT") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const parts = path.split("/");
        const listingId = parts[3];

        const listing = await db.prepare(
          "SELECT * FROM listings WHERE id=?"
        ).bind(listingId).first();

        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        if (String(listing.seller_id) !== String(user.seller_id || user.id)
            && String(user.role).toLowerCase() !== "admin") {
          return sendJSON({ error: "Forbidden" }, 403);
        }

        const b = await request.json();
        await db.prepare(
          `UPDATE listings SET
            title=?, description=?, price=?, level=?, highest_rank=?,
            mythic_items=?, legendary_items=?, gift_items=?, upgraded_guns=?, titles=?, images=?
           WHERE id=?`
        ).bind(
          b.title,
          b.description || "",
          b.price || 0,
          b.level || 0,
          b.highest_rank || "",
          JSON.stringify(b.mythic_items || []),
          JSON.stringify(b.legendary_items || []),
          JSON.stringify(b.gift_items || []),
          JSON.stringify(b.upgraded_guns || []),
          JSON.stringify(b.titles || []),
          JSON.stringify(b.images || []),
          listingId
        ).run();

        return sendJSON({ message: "Listing updated" });
      }

      /* ================= DELETE LISTING ================= */
      if (path.startsWith("/api/listings/") && method === "DELETE") {
        const user = await verifyJWT(request);
        if (!user) return sendJSON({ error: "Unauthorized" }, 401);

        const parts = path.split("/");
        const listingId = parts[3];

        const listing = await db.prepare(
          "SELECT * FROM listings WHERE id=?"
        ).bind(listingId).first();

        if (!listing) return sendJSON({ error: "Listing not found" }, 404);

        if (String(listing.seller_id) !== String(user.seller_id || user.id)
            && String(user.role).toLowerCase() !== "admin") {
          return sendJSON({ error: "Forbidden" }, 403);
        }

        await db.prepare("DELETE FROM listings WHERE id=?").bind(listingId).run();
        return sendJSON({ message: "Listing deleted" });
      }

    } catch (err) {
      console.error(err);
      return sendJSON({ error: "Server error", details: err.message }, 500);
    }

    return sendJSON({ error: "Not found" }, 404);
  }
};
