import { unzipSync } from "fflate";

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
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { VERIFICATION_DB, UPLOADS } = env;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        }
      });

    if (request.method === "OPTIONS") return new Response("ok", { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ service: "verification_service", version: "2.0.0", status: "running" });
    }

    const authUser = async () => {
      const h = request.headers.get("Authorization");
      if (!h || !h.startsWith("Bearer ")) return null;
      return verifyJwt(h.slice(7), env.JWT_SECRET);
    };

    try {
      // Upload offline eKYC ZIP + Share Code (JWT required)
      if (url.pathname === "/upload" && request.method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const formData = await request.formData();
        const file = formData.get("file");
        const shareCode = formData.get("share_code");
        const userId = String(formData.get("user_id") || user.id);

        if (!file || !shareCode) {
          return json({ error: "Missing file or share_code" }, 400);
        }
        if (userId !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }

        const kvKey = `ekyc_${userId}_${Date.now()}`;
        await UPLOADS.put(kvKey, await file.arrayBuffer());

        // Try to extract what we can; otherwise leave blank for manual review
        let parsedData = { name: "", gender: "", dob: "", address: "" };
        try {
          const zipData = unzipSync(new Uint8Array(await file.arrayBuffer()));
          const xmlFile = Object.keys(zipData).find(k => k.endsWith(".xml"));
          if (xmlFile) {
            const xml = new TextDecoder().decode(zipData[xmlFile]);
            const grab = (tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || "";
            parsedData = { name: grab("name"), gender: grab("gender"), dob: grab("dob"), address: grab("address") };
          }
        } catch (e) {
          // not a valid zip or unparseable — still record submission
        }

        const aadhaar = shareCode.length >= 4 ? "XXXX-XXXX-" + shareCode.slice(-4) : null;

        await VERIFICATION_DB.prepare(
          `INSERT INTO user_profiles (user_id, name, gender, dob, address, aadhaar_number, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET
             name=excluded.name, gender=excluded.gender, dob=excluded.dob,
             address=excluded.address, aadhaar_number=excluded.aadhaar_number,
             updated_at=CURRENT_TIMESTAMP`
        ).bind(userId, parsedData.name || null, parsedData.gender || null, parsedData.dob || null, parsedData.address || null, aadhaar).run();

        await VERIFICATION_DB.prepare(
          `INSERT INTO kyc_documents (user_id, document_type, verification_status, confidence, remarks)
           VALUES (?, 'Aadhaar', 'submitted', NULL, 'Awaiting manual review')`
        ).bind(userId).run();

        return json({
          message: "eKYC submitted for review",
          user_id: userId,
          status: "submitted",
          parsed_data: parsedData
        });
      }

      // Fetch user profile (JWT required)
      if (url.pathname.startsWith("/profile/") && request.method === "GET") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const userId = url.pathname.split("/").pop();
        if (userId !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }

        const { results } = await VERIFICATION_DB.prepare("SELECT * FROM user_profiles WHERE user_id = ?").bind(userId).all();
        if (!results || results.length === 0)
          return json({ error: "User not found" }, 404);

        const kyc = await VERIFICATION_DB.prepare(
          "SELECT document_type, verification_status, confidence, remarks, created_at FROM kyc_documents WHERE user_id=? ORDER BY created_at DESC LIMIT 1"
        ).bind(userId).first();

        const stats = await VERIFICATION_DB.prepare("SELECT * FROM seller_stats WHERE seller_id = ?").bind(userId).first();

        return json({ profile: results[0], kyc: kyc || null, seller_stats: stats || null });
      }

      // Update profile info (JWT required)
      if (url.pathname === "/profile/update" && request.method === "POST") {
        const user = await authUser();
        if (!user) return json({ error: "unauthorized" }, 401);

        const data = await request.json();
        const userId = String(data.user_id || user.id);
        if (userId !== String(user.id) && user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        const { name, gender, address, pan_number } = data;

        await VERIFICATION_DB.prepare(
          `UPDATE user_profiles SET name=?, gender=?, address=?, pan_number=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
        ).bind(name || null, gender || null, address || null, pan_number || null, userId).run();

        return json({ message: "Profile updated successfully" });
      }

      // Seller stats (public)
      if (url.pathname.startsWith("/stats/") && request.method === "GET") {
        const sellerId = url.pathname.split("/").pop();
        const stats = await VERIFICATION_DB.prepare("SELECT * FROM seller_stats WHERE seller_id = ?").bind(sellerId).first();
        return json(stats || { seller_id: sellerId, total_ids_sold: 0, badge: "New Seller" });
      }

      /* ================= ADMIN ================= */

      // Admin: KYC review queue
      if (url.pathname === "/admin/queue" && request.method === "GET") {
        const user = await authUser();
        if (!user || user.role !== "admin") return json({ error: "admin_only" }, 403);

        const { results } = await VERIFICATION_DB.prepare(
          `SELECT k.*, u.name FROM kyc_documents k
           LEFT JOIN user_profiles u ON u.user_id=k.user_id
           WHERE k.verification_status='submitted'
           ORDER BY k.created_at DESC LIMIT 100`
        ).all();

        return json(results || []);
      }

      // Admin: approve / reject KYC
      if (url.pathname === "/admin/decision" && request.method === "POST") {
        const user = await authUser();
        if (!user || user.role !== "admin") return json({ error: "admin_only" }, 403);

        const body = await request.json();
        const { doc_id, decision, remarks } = body;
        if (!doc_id || !["approved", "rejected"].includes(decision)) {
          return json({ error: "invalid_payload" }, 400);
        }

        const doc = await VERIFICATION_DB.prepare("SELECT * FROM kyc_documents WHERE id=?").bind(doc_id).first();
        if (!doc) return json({ error: "document_not_found" }, 404);
        if (doc.verification_status !== "submitted") {
          return json({ error: "document_already_reviewed" }, 409);
        }

        await VERIFICATION_DB.prepare(
          `UPDATE kyc_documents SET verification_status=?, remarks=?, confidence=? WHERE id=?`
        ).bind(decision, remarks || "", decision === "approved" ? 100 : 0, doc_id).run();

        if (decision === "approved") {
          const existing = await VERIFICATION_DB.prepare(
            "SELECT id FROM seller_stats WHERE seller_id=?"
          ).bind(doc.user_id).first();
          if (existing) {
            await VERIFICATION_DB.prepare(
              "UPDATE seller_stats SET badge='Verified Seller', updated_at=CURRENT_TIMESTAMP WHERE seller_id=?"
            ).bind(doc.user_id).run();
          } else {
            await VERIFICATION_DB.prepare(
              `INSERT INTO seller_stats (seller_id, total_ids_sold, total_earnings, badge, updated_at)
               VALUES (?, 0, 0, 'Verified Seller', CURRENT_TIMESTAMP)`
            ).bind(doc.user_id).run();
          }
        }

        return json({ message: `KYC ${decision}`, doc_id });
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "server_error", message: err.message }, 500);
    }
  },
};
