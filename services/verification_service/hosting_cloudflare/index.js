function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {bytes[i] = bin.charCodeAt(i);}
  return bytes;
}

async function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {return null;}
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) {return null;}
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (payload.exp && payload.exp * 1000 < Date.now()) {return null;}
    return payload;
  } catch { return null; }
}

function cleanText(v, max = 500) {
  let s = String(v ?? '').replace(/[<>&'"`]/g, '').trim();
  s = s.split('').filter(ch => ch.charCodeAt(0) > 0x1F).join('');
  return s.slice(0, max);
}

export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = ["https://bgmi-frontend.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"];
    const _o = request.headers.get("Origin");
    const ORIGIN = (_o && ALLOWED_ORIGINS.includes(_o)) ? _o : "https://bgmi-frontend.vercel.app";
    const url = new URL(request.url);
    const { VERIFICATION_DB, UPLOADS } = env;

    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-XSS-Protection': '1; mode=block',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ORIGIN, 'Cache-Control': 'no-store', ...securityHeaders,
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        }
      });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization', ...securityHeaders
      }});
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ service: 'verification_service', version: '3.0.0', status: 'running' });
    }

    const authUser = async () => {
      const h = request.headers.get('Authorization');
      if (!h || !h.startsWith('Bearer ')) {return null;}
      return verifyJwt(h.slice(7), env.JWT_SECRET);
    };

    try {

      /* ===== KYC UPLOAD — Aadhaar(12-digit) / PAN + doc photo + optional video + liveness ===== */
      if (url.pathname === '/upload' && request.method === 'POST') {
        const user = await authUser();
        if (!user) {return json({ error: 'unauthorized' }, 401);}

        const formData = await request.formData();
        const file = formData.get('file');
        const video = formData.get('video');
        const name = formData.get('name');
        const docType = String(formData.get('document_type') || 'aadhaar').toLowerCase();
        const idNumber = String(formData.get('id_number') || '').replace(/\s/g, '');
        const livenessRaw = formData.get('liveness_result');
        const userId = String(formData.get('user_id') || user.id);

        if (!name || !idNumber || !file) {
          return json({ error: 'Missing required fields (name, document, ID number)' }, 400);
        }
        if (file.size > 5 * 1024 * 1024) {
          return json({ error: 'Document photo too large (max 5MB)' }, 400);
        }
        if (userId !== String(user.id) && user.role !== 'admin') {
          return json({ error: 'forbidden' }, 403);
        }

        let aadhaarMasked = null;
        let cleanPan = null;
        if (docType === 'aadhaar') {
          if (!/^\d{12}$/.test(idNumber)) {
            return json({ error: 'Aadhaar must be exactly 12 digits' }, 400);
          }
          aadhaarMasked = 'XXXX-XXXX-' + idNumber.slice(-4);
        } else if (docType === 'pan') {
          if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(idNumber.toUpperCase())) {
            return json({ error: 'PAN must be in format ABCDE1234F' }, 400);
          }
          cleanPan = idNumber.toUpperCase();
        } else {
          return json({ error: 'Invalid document type' }, 400);
        }

        let liveness = null;
        try { liveness = livenessRaw ? JSON.parse(String(livenessRaw)) : null; } catch {}

        if (liveness && liveness.result === 'fail') {
          return json({
            error: 'liveness_failed',
            message: 'Face not detected or head movements did not match. Please retake video with better lighting, face visible, and follow the on-screen prompts.'
          }, 422);
        }

        const docKey = `kyc_doc_${userId}_${Date.now()}`;
        const buf = await file.arrayBuffer();
        await UPLOADS.put(docKey, buf, { httpMetadata: { contentType: file.type || 'image/jpeg' } });

        let videoKey = null;
        if (video && video.size > 0) {
          if (video.size > 20 * 1024 * 1024) {
            return json({ error: 'Video too large (max 20MB)' }, 400);
          }
          videoKey = `kyc_video_${userId}_${Date.now()}`;
          const vBuf = await video.arrayBuffer();
          await UPLOADS.put(videoKey, vBuf, { httpMetadata: { contentType: video.type || 'video/webm' } });
        }

        const cleanName = cleanText(name, 100);
        const livenessJSON = liveness ? JSON.stringify({
          passed: liveness.passed || false,
          prompts_completed: liveness.prompts_completed || 0,
          face_detected: liveness.face_detected || false
        }) : null;

        await VERIFICATION_DB.prepare(
          `INSERT INTO user_profiles (user_id, name, pan_number, aadhaar_number, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET
             name=excluded.name, pan_number=COALESCE(excluded.pan_number, user_profiles.pan_number),
             aadhaar_number=COALESCE(excluded.aadhaar_number, user_profiles.aadhaar_number),
             updated_at=CURRENT_TIMESTAMP`
        ).bind(userId, cleanName || null, cleanPan || null, aadhaarMasked || null).run();

        await VERIFICATION_DB.prepare(
          `INSERT INTO kyc_documents (user_id, document_type, document_key, video_key, liveness_result, verification_status, confidence, remarks)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`
        ).bind(userId, docType === 'pan' ? 'PAN' : 'Aadhaar', docKey, videoKey, livenessJSON,
          videoKey ? 'Awaiting admin review (video submitted)' : 'Awaiting admin review (no video)'
        ).run();

        return json({
          message: 'KYC submitted for review',
          user_id: userId,
          document_type: docType,
          has_video: !!videoKey,
          liveness_passed: liveness ? liveness.passed : null,
          status: 'pending'
        });
      }

      /* ===== Seller public UPI ===== */
      if (url.pathname.startsWith('/seller/upi/') && request.method === 'GET') {
        const user = await authUser();
        if (!user) {return json({ error: 'unauthorized' }, 401);}
        const sellerId = String(url.pathname.split('/').pop()).replace(/[^0-9]/g, '');
        if (!sellerId) {return json({ error: 'invalid_seller' }, 400);}
        const prof = await VERIFICATION_DB.prepare(
          'SELECT name, upi_id FROM user_profiles WHERE user_id = ?'
        ).bind(sellerId).first();
        if (!prof || !prof.upi_id) {
          return json({ has_upi: false, upi_id: null, upi_name: prof?.name || 'Seller' });
        }
        return json({ has_upi: true, upi_id: prof.upi_id, upi_name: prof.name || 'Seller' });
      }

      /* ===== Fetch user profile ===== */
      if (url.pathname.startsWith('/profile/') && request.method === 'GET') {
        const user = await authUser();
        if (!user) {return json({ error: 'unauthorized' }, 401);}
        const userId = url.pathname.split('/').pop();
        if (userId !== String(user.id) && user.role !== 'admin') {
          return json({ error: 'forbidden' }, 403);
        }
        const { results } = await VERIFICATION_DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).all();
        if (!results || !results.length) {
          return json({ profile: { user_id: userId }, kyc: null, seller_stats: null });
        }
        const kyc = await VERIFICATION_DB.prepare(
          'SELECT document_type, verification_status, confidence, remarks, created_at FROM kyc_documents WHERE user_id=? ORDER BY created_at DESC LIMIT 1'
        ).bind(userId).first();
        const stats = await VERIFICATION_DB.prepare('SELECT * FROM seller_stats WHERE seller_id = ?').bind(userId).first();
        return json({ profile: results[0], kyc: kyc || null, seller_stats: stats || null });
      }

      /* ===== Update profile info ===== */
      if (url.pathname === '/profile/update' && request.method === 'POST') {
        const user = await authUser();
        if (!user) {return json({ error: 'unauthorized' }, 401);}
        const data = await request.json();
        const userId = String(data.user_id || user.id);
        if (userId !== String(user.id) && user.role !== 'admin') {
          return json({ error: 'forbidden' }, 403);
        }
        const { name, gender, address, pan_number, bio, instagram, facebook, upi_id, photo_url } = data;
        const cleanUpi = String(upi_id || '').replace(/[^\w.@-]/g, '').trim().slice(0, 60);
        if (upi_id && !/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(cleanUpi)) {
          return json({ error: 'Invalid UPI ID (format: name@bank)' }, 400);
        }
        let cleanPhoto = '';
        if (photo_url) {
          cleanPhoto = String(photo_url).trim();
          if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(cleanPhoto)) {
            return json({ error: 'Invalid photo format' }, 400);
          }
          if (cleanPhoto.length > 300000) {
            return json({ error: 'Photo too large (max ~200KB)' }, 400);
          }
        }
        await VERIFICATION_DB.prepare(
          `INSERT INTO user_profiles (user_id, name, gender, address, pan_number, bio, instagram, facebook, upi_id, photo_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET
             name=excluded.name, gender=COALESCE(excluded.gender, user_profiles.gender),
             address=COALESCE(excluded.address, user_profiles.address),
             pan_number=COALESCE(excluded.pan_number, user_profiles.pan_number),
             bio=COALESCE(excluded.bio, user_profiles.bio),
             instagram=COALESCE(excluded.instagram, user_profiles.instagram),
             facebook=COALESCE(excluded.facebook, user_profiles.facebook),
             upi_id=COALESCE(excluded.upi_id, user_profiles.upi_id),
             photo_url=COALESCE(excluded.photo_url, user_profiles.photo_url),
             updated_at=CURRENT_TIMESTAMP`
        ).bind(userId, cleanText(name,100)||null, cleanText(gender,20)||null, cleanText(address,300)||null,
          cleanText(pan_number,20).toUpperCase()||null, cleanText(bio,200)||null,
          cleanText(instagram,80)||null, cleanText(facebook,80)||null, cleanUpi||null, cleanPhoto||null
        ).run();
        return json({ message: 'Profile updated successfully' });
      }

      /* ===== Seller stats ===== */
      if (url.pathname.startsWith('/stats/') && request.method === 'GET') {
        const user = await authUser();
        if (!user) {return json({ error: 'unauthorized' }, 401);}
        const sellerId = url.pathname.split('/').pop();
        const stats = await VERIFICATION_DB.prepare('SELECT * FROM seller_stats WHERE seller_id = ?').bind(sellerId).first();
        return json(stats || { seller_id: sellerId, total_ids_sold: 0, badge: 'New Seller' });
      }

      /* ===== ADMIN: KYC review queue ===== */
      if (url.pathname === '/admin/queue' && request.method === 'GET') {
        const user = await authUser();
        if (!user || user.role !== 'admin') {return json({ error: 'admin_only' }, 403);}
        const { results } = await VERIFICATION_DB.prepare(
          `SELECT k.*, u.name FROM kyc_documents k
           LEFT JOIN user_profiles u ON u.user_id=k.user_id
           WHERE k.verification_status='pending'
           ORDER BY k.created_at DESC LIMIT 100`
        ).all();
        return json(results || []);
      }

      /* ===== ADMIN: approve / reject KYC ===== */
      if (url.pathname === '/admin/decision' && request.method === 'POST') {
        const user = await authUser();
        if (!user || user.role !== 'admin') {return json({ error: 'admin_only' }, 403);}
        const body = await request.json();
        const { doc_id, decision, remarks } = body;
        if (!doc_id || !['approved', 'rejected'].includes(decision)) {
          return json({ error: 'invalid_payload' }, 400);
        }
        const doc = await VERIFICATION_DB.prepare('SELECT * FROM kyc_documents WHERE id=?').bind(doc_id).first();
        if (!doc) {return json({ error: 'document_not_found' }, 404);}
        if (doc.verification_status !== 'pending') {
          return json({ error: 'document_already_reviewed' }, 409);
        }

        const updateSQL = decision === 'approved'
          ? "UPDATE kyc_documents SET verification_status=?, remarks=?, reviewed_at=datetime('now'), reviewed_by=?, approved_at=datetime('now') WHERE id=?"
          : "UPDATE kyc_documents SET verification_status=?, remarks=?, reviewed_at=datetime('now'), reviewed_by=? WHERE id=?";
        await VERIFICATION_DB.prepare(updateSQL).bind(decision, remarks || '', String(user.id), doc_id).run();

        if (decision === 'approved') {
          const existing = await VERIFICATION_DB.prepare('SELECT id FROM seller_stats WHERE seller_id=?').bind(doc.user_id).first();
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

      /* ===== AUTO-PURGE: Delete Aadhaar + video 7 days after approval ===== */
      if (url.pathname === '/admin/purge-kyc' && request.method === 'POST') {
        const user = await authUser();
        if (!user || user.role !== 'admin') {return json({ error: 'admin_only' }, 403);}

        const expired = await VERIFICATION_DB.prepare(
          `SELECT id, document_key, video_key, user_id FROM kyc_documents
           WHERE verification_status='approved' AND approved_at IS NOT NULL
           AND datetime(approved_at, '+7 days') < datetime('now')`
        ).all();

        let purged = 0;
        for (const doc of (expired.results || [])) {
          if (doc.document_key) {
            try { await UPLOADS.delete(doc.document_key); } catch {}
          }
          if (doc.video_key) {
            try { await UPLOADS.delete(doc.video_key); } catch {}
          }
          await VERIFICATION_DB.prepare(
            "UPDATE user_profiles SET aadhaar_number=NULL, updated_at=CURRENT_TIMESTAMP WHERE user_id=?"
          ).bind(doc.user_id).run();
          await VERIFICATION_DB.prepare(
            'DELETE FROM kyc_documents WHERE id=?'
          ).bind(doc.id).run();
          purged++;
        }

        return json({ message: `Purged ${purged} old KYC records`, purged });
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error('verification error', err);
      return json({ error: 'server_error' }, 500);
    }
  },
};
