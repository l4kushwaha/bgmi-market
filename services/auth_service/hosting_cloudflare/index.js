import bcrypt from "bcryptjs";
import * as jose from "jose";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

// OTP Helper
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
        email: "bgmipop00000036@hotmail.com" // ✅ verified sender
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
    console.error("❌ Brevo OTP Error:", err);
    throw new Error("Failed to send OTP email");
  }
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") return handleCORS();

    try {

      // HEALTH
      if (path === "/api/auth/health") {
        return jsonResponse({ status: "ok" });
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      // LOGIN
      if (path === "/api/auth/login" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;
        if (!email || !password) return jsonResponse({ error: "Email & password required" }, 400);

        if (!await checkRateLimit(env, `ip:login:${ip}`, 5, 15)) {
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

        const valid = bcrypt.compareSync(password, user.password_hash);
        if (!valid) {
          await logActivity(env, user.id, "login_failed");
          return jsonResponse({ error: "Invalid password" }, 401);
        }

        const access = await jwtSign({ id: user.id, email: user.email, role: "user" }, env.JWT_SECRET, "15m");
        const refresh = await jwtSign({ id: user.id, email: user.email, role: "user" }, env.JWT_SECRET, "7d");
        await logActivity(env, user.id, "login_success");

        return jsonResponse({ message: "Login successful", user: { id: user.id, email: user.email, role: "user" }, access_token: access, refresh_token: refresh });
      }

      // REGISTER
      if (path === "/api/auth/register" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { email, username, password } = body;
        if (!email || !username || !password) return jsonResponse({ error: "Email, username & password required" }, 400);

        if (TEMP_DOMAINS.some(d => email.endsWith(d))) return jsonResponse({ error: "Disposable email not allowed" }, 400);

        if (!await checkRateLimit(env, `ip:register:${ip}`, 3, 60)) {
          return jsonResponse({ error: "Too many attempts. Try later." }, 429);
        }

        const { results: ex } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=?"
        ).bind(email).all();

        if (ex.length > 0) return jsonResponse({ error: "User already exists" }, 409);

        const hash = bcrypt.hashSync(password, 10);
        const insert = await env.AUTH_DB.prepare(
          "INSERT INTO users(email,username,password_hash,role,created_at) VALUES(?,?,?,?,datetime('now'))"
        ).bind(email, username, hash, "user").run();

        await logActivity(env, insert.lastInsertRowid, "register");
        return jsonResponse({ message: "Registered successfully", user: { id: insert.lastInsertRowid, email, role: "user" } });
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

  // ADMIN
  if (payload.id === 0) {
    const access = await jwtSign(
      { id: 0, email: payload.email, role: "admin" },
      env.JWT_SECRET,
      "15m"
    );
    return jsonResponse({ access_token: access });
  }

  // USER (DB SYNC)
  const { results } = await env.AUTH_DB.prepare(
    "SELECT id, email, role FROM users WHERE id=?"
  ).bind(payload.id).all();

  if (!results.length) {
    return jsonResponse({ error: "User not found" }, 404);
  }

  const user = results[0];

  const access = await jwtSign(
    {
      id: user.id,
      email: user.email,
      role: user.role   // 🔥 DB ROLE
    },
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

  // ✅ Try-catch added here
  try {
    await sendOtpEmail(email, otp, env);
  } catch (e) {
    console.error("❌ OTP send failed:", e);
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
