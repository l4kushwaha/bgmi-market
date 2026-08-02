import bcrypt from "bcryptjs";
import * as jose from "jose";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function handleCORS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function jwtSign(payload, secret, expires = "15m") {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(secret));
}

async function jwtVerify(token, secret) {
  try {
    const { payload } = await jose.jwtVerify(
      token,
      new TextEncoder().encode(secret)
    );
    return payload;
  } catch {
    return null;
  }
}

async function logActivity(env, user_id, type, details = "") {
  if (!user_id) return;
  try {
    await env.AUTH_DB.prepare(
      "INSERT INTO user_activity(user_id,type,details,timestamp) VALUES(?,?,?,datetime('now'))"
    ).bind(user_id, type, details).run();
  } catch (e) {}
}

// Rate Limit
async function checkRateLimit(env, key, limit = 5, windowMin = 15) {
  const now = new Date();
  const { results } = await env.AUTH_DB.prepare(
    "SELECT * FROM rate_limits WHERE key = ? AND expires_at > datetime('now')"
  ).bind(key).all();

  if (results.length > 0) {
    const entry = results[0];
    if (entry.count >= limit) return false;
    await env.AUTH_DB.prepare(
      "UPDATE rate_limits SET count = count + 1 WHERE key = ?"
    ).bind(key).run();
    return true;
  } else {
    const expires = new Date(now.getTime() + windowMin * 60000).toISOString();
    await env.AUTH_DB.prepare(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?)"
    ).bind(key, 1, expires).run();
    return true;
  }
}

const TEMP_DOMAINS = [
  "10minutemail.com",
  "mailinator.com",
  "temp-mail.org",
  "guerrillamail.com"
];

function generateOTP(len = 6) {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOtpEmail(email, otp, env) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: "BGMI Market",
        email: "bgmipop00000036@hotmail.com"
      },
      to: [{ email }],
      subject: "BGMI Market Password Reset OTP",
      htmlContent: `
        <h2>BGMI Market</h2>
        <p>Your OTP is:</p>
        <h1>${otp}</h1>
        <p>Valid for 10 minutes.</p>
      `
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Brevo OTP Error:", err);
    throw new Error("Failed to send OTP email");
  }
}

async function adminOnly(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const token = auth.split(" ")[1];
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

async function authUser(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const token = auth.split(" ")[1];
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload) return null;
  if (payload.id === 0) return payload;
  const { results } = await env.AUTH_DB.prepare(
    "SELECT id, email, username, role, status, created_at FROM users WHERE id=?"
  ).bind(payload.id).all();
  if (!results.length) return null;
  const u = results[0];
  if (u.status && u.status === "banned") return { banned: true };
  return { ...u, email: u.email, role: u.role || "user" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") return handleCORS();

    try {

      if (path === "/api/auth/health") {
        return jsonResponse({ status: "ok", service: "auth" });
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      // =============================================
      // ME (verify token, return current user)
      // =============================================
      if (path === "/api/auth/me" && method === "GET") {
        const user = await authUser(request, env);
        if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
        if (user.banned) return jsonResponse({ error: "Account banned" }, 403);
        return jsonResponse({ user });
      }

      // =============================================
      // ADMIN: STATS
      // =============================================
      if (path === "/api/auth/admin/stats" && method === "GET") {
        const admin = await adminOnly(request, env);
        if (!admin) return jsonResponse({ error: "Admin only" }, 403);

        const totalUsers = (await env.AUTH_DB.prepare("SELECT COUNT(*) AS c FROM users").first());
        const bannedUsers = (await env.AUTH_DB.prepare("SELECT COUNT(*) AS c FROM users WHERE status='banned'").first());
        const todayReg = (await env.AUTH_DB.prepare("SELECT COUNT(*) AS c FROM users WHERE date(created_at)=date('now')").first());
        const recent = await env.AUTH_DB.prepare(
          "SELECT * FROM user_activity ORDER BY timestamp DESC LIMIT 20"
        ).all();

        return jsonResponse({
          total_users: totalUsers?.c || 0,
          banned_users: bannedUsers?.c || 0,
          registered_today: todayReg?.c || 0,
          recent_activity: recent.results || []
        });
      }

      // =============================================
      // ADMIN: LIST USERS
      // =============================================
      if (path === "/api/auth/admin/users" && method === "GET") {
        const admin = await adminOnly(request, env);
        if (!admin) return jsonResponse({ error: "Admin only" }, 403);

        const q = url.searchParams.get("q") || "";
        const limit = Number(url.searchParams.get("limit") || 100);
        let sql = "SELECT id, email, username, role, status, created_at FROM users";
        const binds = [];
        if (q) {
          sql += " WHERE email LIKE ? OR username LIKE ?";
          binds.push(`%${q}%`, `%${q}%`);
        }
        sql += " ORDER BY created_at DESC LIMIT ?";
        binds.push(limit);

        const { results } = await env.AUTH_DB.prepare(sql).bind(...binds).all();
        return jsonResponse(results || []);
      }

      // =============================================
      // ADMIN: UPDATE USER (promote / demote / ban / activate)
      // =============================================
      if (path.startsWith("/api/auth/admin/users/") && method === "PATCH") {
        const admin = await adminOnly(request, env);
        if (!admin) return jsonResponse({ error: "Admin only" }, 403);

        const targetId = Number(path.split("/").pop());
        if (!targetId) return jsonResponse({ error: "Invalid user id" }, 400);
        if (targetId === 0 || targetId === admin.id) {
          return jsonResponse({ error: "Cannot modify this user" }, 403);
        }

        const body = await request.json().catch(() => ({}));
        const { role, status } = body;

        const existing = await env.AUTH_DB.prepare("SELECT * FROM users WHERE id=?").bind(targetId).first();
        if (!existing) return jsonResponse({ error: "User not found" }, 404);

        if (role && !["user", "admin", "seller"].includes(role)) {
          return jsonResponse({ error: "Invalid role" }, 400);
        }
        if (status && !["active", "banned"].includes(status)) {
          return jsonResponse({ error: "Invalid status" }, 400);
        }

        const fields = [];
        const binds = [];
        if (role) { fields.push("role=?"); binds.push(role); }
        if (status) { fields.push("status=?"); binds.push(status); }
        if (!fields.length) return jsonResponse({ error: "Nothing to update" }, 400);

        binds.push(targetId);
        await env.AUTH_DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id=?`).bind(...binds).run();
        await logActivity(env, admin.id, "admin_user_update", `user:${targetId} ${role ? "role:" + role : ""} ${status ? "status:" + status : ""}`);

        return jsonResponse({ message: "User updated", id: targetId, role: role || existing.role, status: status || existing.status });
      }

      // =============================================
      // ADMIN: DELETE USER (permanent ban)
      // =============================================
      if (path.startsWith("/api/auth/admin/users/") && method === "DELETE") {
        const admin = await adminOnly(request, env);
        if (!admin) return jsonResponse({ error: "Admin only" }, 403);

        const targetId = Number(path.split("/").pop());
        if (!targetId || targetId === 0 || targetId === admin.id) {
          return jsonResponse({ error: "Cannot delete this user" }, 403);
        }

        await env.AUTH_DB.prepare("DELETE FROM users WHERE id=?").bind(targetId).run();
        await logActivity(env, admin.id, "admin_user_delete", `user:${targetId}`);
        return jsonResponse({ message: "User deleted", id: targetId });
      }

      // LOGIN
      if (path === "/api/auth/login" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;
        if (!email || !password) return jsonResponse({ error: "Email & password required" }, 400);

        if (!await checkRateLimit(env, `ip:login:${ip}`, 20, 60)) {
          return jsonResponse({ error: "Too many login attempts. Try later." }, 429);
        }

        const ADMIN_EMAIL = env.ADMIN_EMAIL;
        const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
        if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
          return jsonResponse({ error: "Admin credentials not configured" }, 500);
        }

        if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
          const access = await jwtSign({ id: 0, email, role: "admin" }, env.JWT_SECRET, "15m");
          const refresh = await jwtSign({ id: 0, email, role: "admin" }, env.JWT_SECRET, "7d");
          return jsonResponse({ message: "Admin login", user: { id: 0, email, role: "admin" }, access_token: access, refresh_token: refresh });
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=?"
        ).bind(email).all();

        if (!results || results.length === 0) return jsonResponse({ error: "User not found" }, 404);
        const user = results[0];

        if (user.status === "banned") {
          return jsonResponse({ error: "Account banned. Contact support." }, 403);
        }

        const valid = bcrypt.compareSync(password, user.password_hash);
        if (!valid) {
          await logActivity(env, user.id, "login_failed");
          return jsonResponse({ error: "Invalid password" }, 401);
        }

        const access = await jwtSign({ id: user.id, email: user.email, role: user.role || "user" }, env.JWT_SECRET, "15m");
        const refresh = await jwtSign({ id: user.id, email: user.email, role: user.role || "user" }, env.JWT_SECRET, "7d");
        await logActivity(env, user.id, "login_success");

        return jsonResponse({
          message: "Login successful",
          user: { id: user.id, email: user.email, username: user.username, role: user.role || "user" },
          access_token: access,
          refresh_token: refresh
        });
      }

      // REGISTER
      if (path === "/api/auth/register" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { email, username, password } = body;
        if (!email || !username || !password) return jsonResponse({ error: "Email, username & password required" }, 400);

        if (TEMP_DOMAINS.some(d => email.endsWith(d))) return jsonResponse({ error: "Disposable email not allowed" }, 400);

        if (!await checkRateLimit(env, `ip:register:${ip}`, 10, 60)) {
          return jsonResponse({ error: "Too many attempts. Try later." }, 429);
        }

        const { results: ex } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=?"
        ).bind(email).all();

        if (ex.length > 0) return jsonResponse({ error: "User already exists" }, 409);

        const hash = bcrypt.hashSync(password, 10);
        const role =
          env.ADMIN_EMAIL && String(email).toLowerCase() === String(env.ADMIN_EMAIL).toLowerCase()
            ? "admin"
            : "user";
        const insert = await env.AUTH_DB.prepare(
          "INSERT INTO users(email,username,password_hash,role,status,created_at) VALUES(?,?,?,?,?,datetime('now'))"
        ).bind(email, username, hash, role, "active").run();

        const newId = insert.meta?.last_row_id ?? insert.lastInsertRowid;
        await logActivity(env, newId, "register");
        return jsonResponse({ message: "Registered successfully", user: { id: newId, email, role } });
      }

      // REFRESH TOKEN
      if (path === "/api/auth/refresh" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { refresh_token } = body;
        if (!refresh_token) {
          return jsonResponse({ error: "Refresh token required" }, 400);
        }

        const payload = await jwtVerify(refresh_token, env.JWT_SECRET);
        if (!payload) {
          return jsonResponse({ error: "Invalid refresh token" }, 401);
        }

        if (payload.id === 0) {
          const access = await jwtSign(
            { id: 0, email: payload.email, role: "admin" },
            env.JWT_SECRET,
            "15m"
          );
          return jsonResponse({ access_token: access });
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT id, email, role, status FROM users WHERE id=?"
        ).bind(payload.id).all();

        if (!results.length) {
          return jsonResponse({ error: "User not found" }, 404);
        }

        const user = results[0];
        if (user.status === "banned") {
          return jsonResponse({ error: "Account banned" }, 403);
        }

        const access = await jwtSign(
          { id: user.id, email: user.email, role: user.role || "user" },
          env.JWT_SECRET,
          "15m"
        );

        return jsonResponse({ access_token: access });
      }

      // FORGOT PASSWORD (send OTP)
      if (path === "/api/auth/forgot-password" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { email } = body;
        if (!email) return jsonResponse({ error: "Email required" }, 400);

        if (!await checkRateLimit(env, `email:otp:${email}`, 3, 15)) {
          return jsonResponse({ error: "Too many OTP requests. Try later." }, 429);
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT id FROM users WHERE email=?"
        ).bind(email).all();

        if (!results || results.length === 0)
          return jsonResponse({ message: "If email exists, OTP sent" });

        const userId = results[0].id;
        const otp = generateOTP();
        const expiry = new Date(Date.now() + 10 * 60000).toISOString();

        await env.AUTH_DB.prepare(
          "INSERT INTO password_resets(user_id,otp,expires_at) VALUES(?,?,?)"
        ).bind(userId, otp, expiry).run();

        try {
          await sendOtpEmail(email, otp, env);
        } catch (e) {
          console.error("OTP send failed:", e);
          return jsonResponse({ error: "Email service failed" }, 500);
        }

        return jsonResponse({ message: "OTP sent to email" });
      }

      // RESET PASSWORD (using OTP)
      if (path === "/api/auth/reset-password" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { otp, new_password } = body;
        if (!otp || !new_password) return jsonResponse({ error: "OTP & new password required" }, 400);

        const { results } = await env.AUTH_DB.prepare(
          "SELECT * FROM password_resets WHERE otp=? AND expires_at>datetime('now')"
        ).bind(otp).all();

        if (!results || results.length === 0) return jsonResponse({ error: "Invalid or expired OTP" }, 400);

        const reset = results[0];
        const hash = bcrypt.hashSync(new_password, 10);

        await env.AUTH_DB.prepare(
          "UPDATE users SET password_hash=? WHERE id=?"
        ).bind(hash, reset.user_id).run();

        await env.AUTH_DB.prepare(
          "DELETE FROM password_resets WHERE otp=?"
        ).bind(otp).run();

        await logActivity(env, reset.user_id, "password_reset");
        return jsonResponse({ message: "Password reset successful" });
      }

      return jsonResponse({ error: "Route not found" }, 404);

    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Server Error" }, 500);
    }
  }
};
