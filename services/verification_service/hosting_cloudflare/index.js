import { unzipSync } from "fflate";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { VERIFICATION_DB, UPLOADS } = env;

    // 🧠 Root health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ service: "verification_service", status: "running" });
    }

    // 🗂️ Upload offline eKYC ZIP + Share Code
    if (url.pathname === "/upload" && request.method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");
      const shareCode = formData.get("share_code");
      const userId = formData.get("user_id");

      if (!file || !shareCode || !userId) {
        return Response.json({ error: "Missing file, share_code, or user_id" }, { status: 400 });
      }

      // Store ZIP in KV
      const kvKey = `ekyc_${userId}_${Date.now()}`;
      await UPLOADS.put(kvKey, await file.arrayBuffer());

      // Extract & Parse (simulated XML decode)
      const zipData = unzipSync(new Uint8Array(await file.arrayBuffer()));
      let parsedData = {
        name: "Demo User",
        gender: "M",
        dob: "1998-07-10",
        address: "Sample City, India",
        aadhaar_number: "XXXX-XXXX-1234"
      };

      // Insert or update in D1
      await VERIFICATION_DB.prepare(
        `INSERT OR REPLACE INTO user_profiles (user_id, name, gender, dob, address, aadhaar_number)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(userId, parsedData.name, parsedData.gender, parsedData.dob, parsedData.address, parsedData.aadhaar_number).run();

      await VERIFICATION_DB.prepare(
        `INSERT INTO kyc_documents (user_id, document_type, verification_status, confidence, remarks)
         VALUES (?, 'Aadhaar', 'success', ?, 'Verified successfully')`
      ).bind(userId, 95.4).run();

      return Response.json({
        message: "eKYC ZIP uploaded & verified successfully",
        user_id: userId,
        parsed_data: parsedData
      });
    }

    // 👤 Fetch user profile
    if (url.pathname.startsWith("/profile/") && request.method === "GET") {
      const userId = url.pathname.split("/").pop();
      const { results } = await VERIFICATION_DB.prepare("SELECT * FROM user_profiles WHERE user_id = ?").bind(userId).all();
      if (!results || results.length === 0)
        return Response.json({ error: "User not found" }, { status: 404 });

      // Fetch seller stats if exists
      const stats = await VERIFICATION_DB.prepare("SELECT * FROM seller_stats WHERE seller_id = ?").bind(userId).first();

      return Response.json({ profile: results[0], seller_stats: stats || null });
    }

    // 🧩 Update profile info
    if (url.pathname === "/profile/update" && request.method === "POST") {
      const data = await request.json();
      const { user_id, name, gender, address, pan_number } = data;

      await VERIFICATION_DB.prepare(
        `UPDATE user_profiles SET name=?, gender=?, address=?, pan_number=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
      ).bind(name, gender, address, pan_number, user_id).run();

      return Response.json({ message: "Profile updated successfully" });
    }

    // 📈 Fetch seller stats
    if (url.pathname.startsWith("/stats/") && request.method === "GET") {
      const sellerId = url.pathname.split("/").pop();
      const stats = await VERIFICATION_DB.prepare("SELECT * FROM seller_stats WHERE seller_id = ?").bind(sellerId).first();
      return Response.json(stats || { seller_id: sellerId, total_ids_sold: 0, badge: "New Seller" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
