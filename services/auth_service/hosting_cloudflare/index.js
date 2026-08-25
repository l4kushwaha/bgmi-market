import bcrypt from 'bcryptjs';
import * as jose from 'jose';
import { oauthStart, oauthCallback } from './oauth-routes.js';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://bgmi-frontend.vercel.app', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  ...securityHeaders
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function handleCORS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function jwtSign(payload, secret, expires = '15m') {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
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

// Hash refresh token for storage (using SHA-256)
async function hashRefreshToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Store refresh token in database
async function storeRefreshToken(env, userId, token, expiresIn = '7d') {
  const tokenHash = await hashRefreshToken(token);
  const expiresAt = sqliteDatetime(new Date(Date.now() + parseDuration(expiresIn)));
  
  await env.AUTH_DB.prepare(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked, created_at)
     VALUES (?, ?, ?, 0, datetime('now'))`
  ).bind(userId, tokenHash, expiresAt).run();
  
  // Clean up old revoked/expired tokens for this user
  await env.AUTH_DB.prepare(
    'DELETE FROM refresh_tokens WHERE user_id = ? AND (revoked = 1 OR expires_at < datetime(\'now\'))'
  ).bind(userId).run();
}

// Revoke refresh token
async function revokeRefreshToken(env, token) {
  const tokenHash = await hashRefreshToken(token);
  await env.AUTH_DB.prepare(
    'UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?'
  ).bind(tokenHash).run();
}

// Revoke all refresh tokens for a user
async function revokeAllUserRefreshTokens(env, userId) {
  await env.AUTH_DB.prepare(
    'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?'
  ).bind(userId).run();
}

// Check if refresh token is valid (not revoked, not expired)
async function isRefreshTokenValid(env, token) {
  const tokenHash = await hashRefreshToken(token);
  const { results } = await env.AUTH_DB.prepare(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime(\'now\')'
  ).bind(tokenHash).all();
  return results.length > 0;
}

// Parse duration string (e.g., "7d", "15m", "1h") to milliseconds
function parseDuration(str) {
  const match = str.match(/^(\d+)([dhms])$/);
  if (!match) {return 7 * 24 * 60 * 60 * 1000;} // default 7 days
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
  case 'd': return value * 24 * 60 * 60 * 1000;
  case 'h': return value * 60 * 60 * 1000;
  case 'm': return value * 60 * 1000;
  case 's': return value * 1000;
  default: return 7 * 24 * 60 * 60 * 1000;
  }
}

async function logActivity(env, user_id, type, details = '') {
  if (!user_id) {return;}
  try {
    await env.AUTH_DB.prepare(
      "INSERT INTO user_activity(user_id,type,details,timestamp) VALUES(?,?,?,datetime('now'))"
    ).bind(user_id, type, details).run();
  } catch {
    // Ignore activity logging errors
  }
}

// Rate Limit
async function checkRateLimit(env, key, limit = 5, windowMin = 15) {
  const now = new Date();
  try {
    const { results } = await env.AUTH_DB.prepare(
      "SELECT * FROM rate_limits WHERE key = ? AND expires_at > datetime('now')"
    ).bind(key).all();

    if (results.length > 0) {
      const entry = results[0];
      if (entry.count >= limit) {return false;}
      await env.AUTH_DB.prepare(
        'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
      ).bind(key).run();
      return true;
    } else {
      const expires = sqliteDatetime(new Date(now.getTime() + windowMin * 60000));
      // clear any stale (expired) row for this key to avoid UNIQUE conflicts
      await env.AUTH_DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
      const insert = await env.AUTH_DB.prepare(
        'INSERT OR IGNORE INTO rate_limits(key,count,expires_at) VALUES(?,?,?)'
      ).bind(key, 1, expires).run();
      if (insert.meta.changes === 0) {
        // raced: a concurrent request inserted the row between SELECT and INSERT
        await env.AUTH_DB.prepare(
          'UPDATE rate_limits SET count = count + 1, expires_at = ? WHERE key = ?'
        ).bind(expires, key).run();
      }
      return true;
    }
  } catch (e) {
    console.error('rate limit error:', e.message);
    return true;
  }
}

// SQLite datetime() format: YYYY-MM-DD HH:MM:SS (string-comparable with datetime('now'))
function sqliteDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const TEMP_DOMAINS = [
  '10minutemail.com',
  'mailinator.com',
  'temp-mail.org',
  'guerrillamail.com'
];

function secureDigit() {
  const arr = new Uint8Array(1);
  do {
    crypto.getRandomValues(arr);
  } while (arr[0] >= 250); // rejection sample â†’ uniform 0-9
  return arr[0] % 10;
}

function generateOTP(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) {s += secureDigit();}
  return s;
}

async function sendOtpEmail(email, otp, env) {
  const html = `
    <div style="max-width:480px;margin:0 auto;font-family:Segoe UI,Arial,sans-serif;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eee">
      <div style="background:linear-gradient(135deg,#ff2d78,#ff7a1a);padding:26px;text-align:center;color:#fff">
        <div style="font-size:1.5rem;font-weight:800;letter-spacing:.5px">BGMI MARKET</div>
        <div style="opacity:.9;font-size:.85rem">India's Trusted Gaming Marketplace</div>
      </div>
      <div style="padding:30px 28px;color:#222">
        <h2 style="margin:0 0 6px;font-size:1.25rem">Verify your email</h2>
        <p style="color:#555;margin:0 0 18px">Use this One-Time Password to complete your verification. It expires in <b>10 minutes</b>.</p>
        <div style="text-align:center;background:#f7f7fa;border:1px dashed #ddd;border-radius:12px;padding:18px;margin-bottom:18px">
          <span style="font-size:2.3rem;font-weight:800;letter-spacing:10px;color:#111">${otp}</span>
        </div>
        <p style="color:#777;font-size:.85rem;margin:0">Never share this code with anyone — BGMI Market staff will never ask for it. If you didn't request this, you can safely ignore this email.</p>
      </div>
      <div style="padding:14px;text-align:center;color:#aaa;font-size:.75rem;background:#fafafa">&copy; 2026 BGMI Market · Secure Escrow · Direct UPI</div>
    </div>
  `;

  // Preferred: EmailJS (works with any Gmail/Outlook, NO domain verification needed)
  if (env.EMAILJS_SERVICE_ID && env.EMAILJS_TEMPLATE_ID && env.EMAILJS_PUBLIC_KEY) {
    const ej = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: env.EMAILJS_SERVICE_ID,
        template_id: env.EMAILJS_TEMPLATE_ID,
        user_id: env.EMAILJS_PUBLIC_KEY,
        template_params: { to_email: email, to_name: email, otp }
      })
    });
    if (ej.ok) {return;}
    console.error('EmailJS OTP Error:', ej.status);
  }

  // Try Brevo second
  const brevo = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: 'BGMI Market',
        email: 'bgmipop0000000033@gmail.com'
      },
      to: [{ email }],
      subject: 'BGMI Market Password Reset OTP',
      htmlContent: html
    })
  });
  if (brevo.ok) {return;}
  console.error('Brevo OTP Error:', brevo.status);

  // Fallback: Resend
  if (!env.RESEND_API_KEY) {throw new Error('EmailJS not configured + Brevo ' + brevo.status + ' failed');}
  const resend = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'BGMI Market <onboarding@resend.dev>',
      to: [email],
      subject: 'BGMI Market Password Reset OTP',
      html
    })
  });
  if (!resend.ok) {throw new Error('Brevo ' + brevo.status + ' + Resend ' + resend.status);}
}

async function adminOnly(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth) {return null;}
  const token = auth.split(' ')[1];
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload || payload.role !== 'admin') {return null;}
  return payload;
}

async function authUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth) {return null;}
  const token = auth.split(' ')[1];
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload) {return null;}
  if (payload.id === 0) {return payload;}
  const { results } = await env.AUTH_DB.prepare(
    'SELECT id, email, username, role, status, created_at FROM users WHERE id=? AND deleted_at IS NULL'
  ).bind(payload.id).all();
  if (!results.length) {return null;}
  const u = results[0];
  if (u.status && u.status === 'banned') {return { banned: true };}
  return { ...u, email: u.email, role: u.role || 'user' };
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await env.AUTH_DB.prepare("UPDATE users SET status='purged', email=email||'.purged', deleted_at=deleted_at WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 day')").run();
      console.log('cron purge users:', r.meta.changes);
    } catch (e) { console.error('purge error:', e.message); }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === 'OPTIONS') {return handleCORS();}

    try {

      if (path === '/api/auth/health') {
        return jsonResponse({ status: 'ok', service: 'auth' });
      }

      // =============================================
      // OAUTH (google / facebook)
      // =============================================
      if (path.startsWith('/api/auth/oauth/')) {
        const parts = path.split('/');
        const provider = parts[4];
        const origin = url.origin;
        return parts[5] === 'callback'
          ? await oauthCallback(env, provider, url, origin)
          : await oauthStart(env, provider, origin);
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      // =============================================
      // ME (verify token, return current user)
      // =============================================
      if (path === '/api/auth/me' && method === 'GET') {
        const user = await authUser(request, env);
        if (!user) {return jsonResponse({ error: 'Unauthorized' }, 401);}
        if (user.banned) {return jsonResponse({ error: 'Account banned' }, 403);}
        return jsonResponse({ user });
      }

      // =============================================
      // PROFILE: GET + EDIT (bio, socials, contact, kyc status)
      // =============================================
      const cleanP = (v, max) => String(v ?? '').replace(/[<>&'"`]/g, '').trim().slice(0, max);
      if (path === '/api/auth/profile' && method === 'GET') {
        const user = await authUser(request, env);
        if (!user) {return jsonResponse({ error: 'Unauthorized' }, 401);}
        await env.AUTH_DB.prepare(
          'INSERT OR IGNORE INTO user_profiles (user_id, name) VALUES (?, ?)'
        ).bind(user.id, cleanP(user.username, 40)).run();
        const p = await env.AUTH_DB.prepare('SELECT * FROM user_profiles WHERE user_id=?').bind(user.id).first();
        return jsonResponse({
          profile: {
            name: p?.name || '', bio: p?.bio || '', contact: p?.contact || '',
            telegram: p?.telegram || '', instagram: p?.instagram || '',
            facebook: p?.facebook || '', kyc_status: p?.kyc_status || 'unverified'
          }
        });
      }
      if (path === '/api/auth/profile' && method === 'PUT') {
        const user = await authUser(request, env);
        if (!user) {return jsonResponse({ error: 'Unauthorized' }, 401);}
        const b = await request.json().catch(() => ({}));
        const fields = {
          name: cleanP(b.name ?? b.username, 40),
          bio: cleanP(b.bio, 300),
          contact: cleanP(b.contact, 20).replace(/[^0-9+\-\s]/g, ''),
          telegram: cleanP(b.telegram, 60).replace(/^@/, ''),
          instagram: cleanP(b.instagram, 60),
          facebook: cleanP(b.facebook, 60)
        };
        // social handle validation: alphanumeric/underscore/dot only
        for (const k of ['telegram', 'instagram', 'facebook']) {
          if (fields[k] && !/^[A-Za-z0-9._]+$/.test(fields[k])) {
            return jsonResponse({ error: `Invalid ${k} handle` }, 400);
          }
        }
        await env.AUTH_DB.prepare(
          'INSERT OR IGNORE INTO user_profiles (user_id, name) VALUES (?, ?)'
        ).bind(user.id, fields.name || cleanP(user.username, 40)).run();
        await env.AUTH_DB.prepare(
          `UPDATE user_profiles SET name=?, bio=?, contact=?, telegram=?, instagram=?, facebook=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
        ).bind(fields.name || null, fields.bio, fields.contact, fields.telegram, fields.instagram, fields.facebook, user.id).run();
        const p = await env.AUTH_DB.prepare('SELECT * FROM user_profiles WHERE user_id=?').bind(user.id).first();
        return jsonResponse({
          message: 'Profile updated',
          profile: {
            name: p?.name || '', bio: p?.bio || '', contact: p?.contact || '',
            telegram: p?.telegram || '', instagram: p?.instagram || '',
            facebook: p?.facebook || '', kyc_status: p?.kyc_status || 'unverified'
          }
        });
      }

      // =============================================
      // ADMIN: STATS
      // =============================================
      if (path === '/api/auth/admin/stats' && method === 'GET') {
        const admin = await adminOnly(request, env);
        if (!admin) {return jsonResponse({ error: 'Admin only' }, 403);}

        const totalUsers = (await env.AUTH_DB.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').first());
        const bannedUsers = (await env.AUTH_DB.prepare("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND status='banned'").first());
        const todayReg = (await env.AUTH_DB.prepare("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND date(created_at)=date('now')").first());
        const recent = await env.AUTH_DB.prepare(
          'SELECT * FROM user_activity ORDER BY timestamp DESC LIMIT 20'
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
      if (path === '/api/auth/admin/users' && method === 'GET') {
        const admin = await adminOnly(request, env);
        if (!admin) {return jsonResponse({ error: 'Admin only' }, 403);}

        const q = url.searchParams.get('q') || '';
        const limit = Number(url.searchParams.get('limit') || 100);
        let sql = 'SELECT id, email, username, role, status, created_at FROM users';
        const binds = [];
        if (q) {
          sql += ' WHERE email LIKE ? OR username LIKE ?';
          binds.push(`%${q}%`, `%${q}%`);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        binds.push(limit);

        const { results } = await env.AUTH_DB.prepare(sql).bind(...binds).all();
        return jsonResponse(results || []);
      }

      // =============================================
      // ADMIN: UPDATE USER (promote / demote / ban / activate)
      // =============================================
      if (path.startsWith('/api/auth/admin/users/') && method === 'PATCH') {
        const admin = await adminOnly(request, env);
        if (!admin) {return jsonResponse({ error: 'Admin only' }, 403);}

        const targetId = Number(path.split('/').pop());
        if (!targetId) {return jsonResponse({ error: 'Invalid user id' }, 400);}
        if (targetId === 0 || targetId === admin.id) {
          return jsonResponse({ error: 'Cannot modify this user' }, 403);
        }

        const body = await request.json().catch(() => ({}));
        const { role, status } = body;

        const existing = await env.AUTH_DB.prepare('SELECT * FROM users WHERE id=?').bind(targetId).first();
        if (!existing) {return jsonResponse({ error: 'User not found' }, 404);}

        if (role && !['user', 'admin', 'seller'].includes(role)) {
          return jsonResponse({ error: 'Invalid role' }, 400);
        }
        if (status && !['active', 'banned'].includes(status)) {
          return jsonResponse({ error: 'Invalid status' }, 400);
        }

        const fields = [];
        const binds = [];
        if (role) { fields.push('role=?'); binds.push(role); }
        if (status) { fields.push('status=?'); binds.push(status); }
        if (!fields.length) {return jsonResponse({ error: 'Nothing to update' }, 400);}

        binds.push(targetId);
        await env.AUTH_DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id=?`).bind(...binds).run();
        await logActivity(env, admin.id, 'admin_user_update', `user:${targetId} ${role ? 'role:' + role : ''} ${status ? 'status:' + status : ''}`);

        return jsonResponse({ message: 'User updated', id: targetId, role: role || existing.role, status: status || existing.status });
      }

      // =============================================
      // ADMIN: DELETE USER (permanent ban)
      // =============================================
      if (path.startsWith('/api/auth/admin/users/') && method === 'DELETE') {
        const admin = await adminOnly(request, env);
        if (!admin) {return jsonResponse({ error: 'Admin only' }, 403);}

        const targetId = Number(path.split('/').pop());
        if (!targetId || targetId === 0 || targetId === admin.id) {
          return jsonResponse({ error: 'Cannot delete this user' }, 403);
        }

        await env.AUTH_DB.prepare("UPDATE users SET status='deleted', deleted_at=datetime('now') WHERE id=?").bind(targetId).run();
        await logActivity(env, admin.id, 'admin_user_delete', `user:${targetId}`);
        return jsonResponse({ message: 'User deleted', id: targetId });
      }

      // LOGIN
      if (path === '/api/auth/login' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;
        if (!email || !password) {return jsonResponse({ error: 'Email & password required' }, 400);}

        if (!await checkRateLimit(env, `ip:login:${ip}`, 20, 60)) {
          return jsonResponse({ error: 'Too many login attempts. Try later.' }, 429);
        }
        if (!await checkRateLimit(env, `acc:login:${String(email).toLowerCase()}`, 40, 60)) {
          return jsonResponse({ error: 'Too many attempts for this account. Try later.' }, 429);
        }

        const ADMIN_EMAIL = env.ADMIN_EMAIL;
        const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
        if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
          return jsonResponse({ error: 'Admin credentials not configured' }, 500);
        }

        if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
          const access = await jwtSign({ id: 0, email, role: 'admin', name: 'Admin', type: 'access' }, env.JWT_SECRET, '7d');
          const refresh = await jwtSign({ id: 0, email, role: 'admin', name: 'Admin', type: 'refresh' }, env.JWT_SECRET, '30d');
          return jsonResponse({ message: 'Admin login', user: { id: 0, email, role: 'admin', name: 'Admin' }, access_token: access, refresh_token: refresh });
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=? COLLATE NOCASE AND deleted_at IS NULL"
        ).bind(email).all();

        const user = results && results.length > 0 ? results[0] : null;

        const DUMMY_HASH = '$2b$10$y37eLNfiRW.KiBkChetdfud0yEzWzBIsiI45YS6QiOpZdxVXfGn6C';
        const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
        if (!valid || !user) {
          await logActivity(env, user ? user.id : null, 'login_failed');
          return jsonResponse({ error: 'Invalid email or password' }, 401);
        }

        if (user.status === 'banned') {
          return jsonResponse({ error: 'Account banned. Contact support.' }, 403);
        }

        if (user.email_verified === 0) {
          return jsonResponse({
            error: 'Email not verified. Enter the OTP sent to your email to activate your account.',
            code: 'EMAIL_NOT_VERIFIED'
          }, 403);
        }

        const access = await jwtSign({ id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'access' }, env.JWT_SECRET, '7d');
        const refresh = await jwtSign({ id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'refresh' }, env.JWT_SECRET, '30d');
        
        // Store refresh token in database
        await storeRefreshToken(env, user.id, refresh, '7d');
        
        await logActivity(env, user.id, 'login_success');

        return jsonResponse({
          message: 'Login successful',
          user: { id: user.id, email: user.email, username: user.username, role: user.role || 'user', name: user.username },
          access_token: access,
          refresh_token: refresh
        });
      }

      // REGISTER
      if (path === '/api/auth/register' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email, username, password } = body;
        if (!email || !username || !password) {return jsonResponse({ error: 'Email, username & password required' }, 400);}

        if (typeof password !== 'string' || password.length < 8) {
          return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
        }
        if (password.length > 128) {return jsonResponse({ error: 'Password too long' }, 400);}

        const cleanUser = String(username).replace(/[<>&'"`;()]/g, '').trim().slice(0, 20);
        if (!/^[A-Za-z0-9_ ]{3,20}$/.test(cleanUser)) {
          return jsonResponse({ error: 'Username must be 3-20 characters (letters, numbers, _)' }, 400);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email)) || String(email).length > 100) {
          return jsonResponse({ error: 'Invalid email format' }, 400);
        }

        if (TEMP_DOMAINS.some(d => email.endsWith(d))) {return jsonResponse({ error: 'Disposable email not allowed' }, 400);}

        if (!await checkRateLimit(env, `ip:register:${ip}`, 10, 60)) {
          return jsonResponse({ error: 'Too many attempts. Try later.' }, 429);
        }

        const { results: ex } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=? COLLATE NOCASE AND deleted_at IS NULL"
        ).bind(email).all();

        if (ex.length > 0) {return jsonResponse({ error: 'User already exists' }, 409);}

        const hash = bcrypt.hashSync(password, 10);
        const role =
          env.ADMIN_EMAIL && String(email).toLowerCase() === String(env.ADMIN_EMAIL).toLowerCase()
            ? 'admin'
            : 'user';
        const insert = await env.AUTH_DB.prepare(
          "INSERT INTO users(email,username,password_hash,role,status,email_verified,created_at) VALUES(?,?,?,?,?,?,datetime('now'))"
        ).bind(email, cleanUser, hash, role, 'active', 0).run();

        const newId = insert.meta?.last_row_id ?? insert.lastInsertRowid;

        /* V24: real-user signup — email OTP gate restored.
           Auto-login happens on successful OTP at /api/auth/verify-email. */
        const otp = generateOTP();
        const expiry = sqliteDatetime(new Date(Date.now() + 10 * 60000));
        await env.AUTH_DB.prepare('DELETE FROM email_verifications WHERE user_id=?').bind(newId).run();
        await env.AUTH_DB.prepare(
          'INSERT INTO email_verifications(user_id,otp,expires_at) VALUES(?,?,?)'
        ).bind(newId, otp, expiry).run();
        await sendOtpEmail(email, otp, env);

        await logActivity(env, newId, 'register');
        return jsonResponse({
          message: 'Check your email for OTP to activate your account',
          user: { id: newId, email, username: cleanUser, role },
          verify_required: true
        });
      }

      // VERIFY EMAIL (signup OTP)
      if (path === '/api/auth/verify-email' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email, otp } = body;
        if (!email || !otp) {return jsonResponse({ error: 'Email & OTP required' }, 400);}
        if (!await checkRateLimit(env, `ip:verify:${ip}`, 10, 60)) {
          return jsonResponse({ error: 'Too many attempts. Try later.' }, 429);
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=? COLLATE NOCASE AND deleted_at IS NULL"
        ).bind(email).all();
        if (!results.length) {return jsonResponse({ error: 'Invalid or expired OTP' }, 400);}

        const user = results[0];
        if (user.email_verified === 1) {return jsonResponse({ message: 'Email already verified' });}
        if (user.status === 'banned') {return jsonResponse({ error: 'Account banned. Contact support.' }, 403);}

        const { results: vres } = await env.AUTH_DB.prepare(
          "SELECT * FROM email_verifications WHERE user_id=? AND otp=? AND expires_at>datetime('now')"
        ).bind(user.id, String(otp)).all();
        if (!vres || vres.length === 0) {
          if (!await checkRateLimit(env, `otpfail:${user.id}`, 6, 600)) {
            return jsonResponse({ error: 'Too many invalid attempts. Request a new OTP.' }, 429);
          }
          return jsonResponse({ error: 'Invalid or expired OTP' }, 400);
        }

        await env.AUTH_DB.prepare(
          'UPDATE users SET email_verified=1 WHERE id=?'
        ).bind(user.id).run();
        await env.AUTH_DB.prepare(
          'DELETE FROM email_verifications WHERE user_id=?'
        ).bind(user.id).run();

        // V24: auto-login on successful verification — issue session tokens
        const access = await jwtSign({ id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'access' }, env.JWT_SECRET, '7d');
        const refresh = await jwtSign({ id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'refresh' }, env.JWT_SECRET, '30d');
        await storeRefreshToken(env, user.id, refresh, '7d');
        await logActivity(env, user.id, 'login_success');

        return jsonResponse({
          message: 'Email verified successfully',
          user: { id: user.id, email: user.email, username: user.username, role: user.role || 'user', name: user.username },
          access_token: access,
          refresh_token: refresh
        });
      }

      // RESEND VERIFICATION OTP
      if (path === '/api/auth/resend-verification' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email } = body;
        if (!email) {return jsonResponse({ error: 'Email required' }, 400);}
        if (!await checkRateLimit(env, `email:otp:${email}`, 3, 15)) {
          return jsonResponse({ error: 'Too many OTP requests. Try later.' }, 429);
        }
        if (!await checkRateLimit(env, `ip:otp:${ip}`, 10, 60)) {
          return jsonResponse({ error: 'Too many OTP requests from this device. Try later.' }, 429);
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT * FROM users WHERE email=? COLLATE NOCASE AND deleted_at IS NULL"
        ).bind(email).all();
        if (!results.length) {return jsonResponse({ message: 'If your email is registered and unverified, a new OTP has been sent.' });}

        const user = results[0];
        if (user.email_verified === 1) {return jsonResponse({ message: 'Email already verified' });}

        const otp = generateOTP();
        const expiry = sqliteDatetime(new Date(Date.now() + 10 * 60000));
        await env.AUTH_DB.prepare(
          'DELETE FROM email_verifications WHERE user_id=?'
        ).bind(user.id).run();
        await env.AUTH_DB.prepare(
          'INSERT INTO email_verifications(user_id,otp,expires_at) VALUES(?,?,?)'
        ).bind(user.id, otp, expiry).run();

        try {
          await sendOtpEmail(email, otp, env);
        } catch (e) {
          console.error('Resend verification OTP failed:', e);
          return jsonResponse({ error: 'Could not send OTP email. Try again later.' }, 503);
        }
        return jsonResponse({ message: 'OTP resent to email' });
      }

      // REFRESH TOKEN (with rotation)
      if (path === '/api/auth/refresh' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { refresh_token } = body;
        if (!refresh_token) {
          return jsonResponse({ error: 'Refresh token required' }, 400);
        }

        const payload = await jwtVerify(refresh_token, env.JWT_SECRET);
        if (!payload) {
          return jsonResponse({ error: 'Invalid refresh token' }, 401);
        }

        // Verify token type is refresh
        if (payload.type !== 'refresh') {
          return jsonResponse({ error: 'Invalid token type' }, 401);
        }

        if (payload.id === 0) {
          // Admin: rotate refresh token
          await revokeRefreshToken(env, refresh_token);
          const newRefresh = await jwtSign({ id: 0, email: payload.email, role: 'admin', name: 'Admin', type: 'refresh' }, env.JWT_SECRET, '30d');
          const access = await jwtSign({ id: 0, email: payload.email, role: 'admin', name: 'Admin', type: 'access' }, env.JWT_SECRET, '7d');
          return jsonResponse({ access_token: access, refresh_token: newRefresh });
        }

        // Check if refresh token is valid in database (not revoked, not expired)
        const isValid = await isRefreshTokenValid(env, refresh_token);
        if (!isValid) {
          return jsonResponse({ error: 'Refresh token revoked or expired' }, 401);
        }

        const { results } = await env.AUTH_DB.prepare(
          'SELECT id, email, username, role, status FROM users WHERE id=? AND deleted_at IS NULL'
        ).bind(payload.id).all();

        if (!results.length) {
          return jsonResponse({ error: 'User not found' }, 404);
        }

        const user = results[0];
        if (user.status === 'banned') {
          return jsonResponse({ error: 'Account banned' }, 403);
        }

        // Rotate refresh token: revoke old, issue new
        await revokeRefreshToken(env, refresh_token);
        const newRefresh = await jwtSign({ id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'refresh' }, env.JWT_SECRET, '30d');
        await storeRefreshToken(env, user.id, newRefresh, '7d');
        
        const access = await jwtSign(
          { id: user.id, email: user.email, role: user.role || 'user', name: user.username, type: 'access' },
          env.JWT_SECRET,
          '15m'
        );

        return jsonResponse({ access_token: access, refresh_token: newRefresh });
      }

      // FORGOT PASSWORD (send OTP)
      if (path === '/api/auth/forgot-password' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email } = body;
        if (!email) {return jsonResponse({ error: 'Email required' }, 400);}

        if (!await checkRateLimit(env, `email:otp:${email}`, 3, 15)) {
          return jsonResponse({ error: 'Too many OTP requests. Try later.' }, 429);
        }
        if (!await checkRateLimit(env, `ip:otp:${ip}`, 10, 60)) {
          return jsonResponse({ error: 'Too many OTP requests from this device. Try later.' }, 429);
        }

        const { results } = await env.AUTH_DB.prepare(
          'SELECT id FROM users WHERE email=? COLLATE NOCASE AND (deleted_at IS NULL)'
        ).bind(email).all();

        if (!results || results.length === 0)
        {return jsonResponse({ message: 'If email exists, OTP sent' });}

        const userId = results[0].id;
        const otp = generateOTP();
        const expiry = sqliteDatetime(new Date(Date.now() + 10 * 60000));

        await env.AUTH_DB.prepare(
          'DELETE FROM password_resets WHERE user_id=?'
        ).bind(userId).run();
        await env.AUTH_DB.prepare(
          'INSERT INTO password_resets(user_id,otp,expires_at) VALUES(?,?,?)'
        ).bind(userId, otp, expiry).run();

        try {
          await sendOtpEmail(email, otp, env);
        } catch (e) {
          console.error('OTP send failed:', e);
          // SECURITY: backup-code is returned ONLY when explicitly enabled (DEV_OTP_RETURN="1")
          // AND the target email is allow-listed (DEV_OTP_EMAILS="a@x,b@y"). Off by default so
          // a stranger who knows a user's email cannot take over the account.
          console.error('OTP send failed:', e);
          return jsonResponse({ error: 'Could not send OTP email. Try again later.' }, 503);
        }

        return jsonResponse({ message: 'OTP sent to email' });
      }

      // RESET PASSWORD (using OTP)
      if (path === '/api/auth/reset-password' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { email, otp, new_password } = body;
        if (!email || !otp || !new_password) {return jsonResponse({ error: 'Email, OTP & new password required' }, 400);}
        if (typeof new_password !== 'string' || new_password.length < 8 || new_password.length > 128) {
          return jsonResponse({ error: 'Password must be 8-128 characters' }, 400);
        }

        if (!await checkRateLimit(env, `ip:reset:${ip}`, 10, 60)) {
          return jsonResponse({ error: 'Too many reset attempts. Try later.' }, 429);
        }
        if (!await checkRateLimit(env, `reset:acct:${String(email).toLowerCase()}`, 5, 60)) {
          return jsonResponse({ error: 'Too many reset attempts for this account. Try later.' }, 429);
        }

        const { results } = await env.AUTH_DB.prepare(
          "SELECT r.* FROM password_resets r JOIN users u ON u.id=r.user_id WHERE LOWER(u.email)=LOWER(?) AND r.otp=? AND expires_at>datetime('now') LIMIT 1"
        ).bind(String(email), otp).all();

        if (!results || results.length === 0) {return jsonResponse({ error: 'Invalid or expired OTP' }, 400);}

        const reset = results[0];
        const hash = bcrypt.hashSync(new_password, 10);

        await env.AUTH_DB.prepare(
          'UPDATE users SET password_hash=? WHERE id=?'
        ).bind(hash, reset.user_id).run();

        // Revoke all refresh tokens on password change (security best practice)
        await revokeAllUserRefreshTokens(env, reset.user_id);

        await env.AUTH_DB.prepare(
          'DELETE FROM password_resets WHERE otp=?'
        ).bind(otp).run();

        await logActivity(env, reset.user_id, 'password_reset');
        return jsonResponse({ message: 'Password reset successful' });
      }

      // LOGOUT (revoke refresh token)
      if (path === '/api/auth/logout' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { refresh_token } = body;
        if (refresh_token) {
          await revokeRefreshToken(env, refresh_token);
        }
        // Also support revoking all tokens for the user (from access token)
        const auth = request.headers.get('Authorization');
        if (auth) {
          const token = auth.split(' ')[1];
          const payload = await jwtVerify(token, env.JWT_SECRET);
          if (payload && payload.id && payload.id !== 0) {
            await revokeAllUserRefreshTokens(env, payload.id);
          }
        }
        return jsonResponse({ message: 'Logged out successfully' });
      }

      // LOGOUT ALL DEVICES (revoke all user's refresh tokens)
      if (path === '/api/auth/logout-all' && method === 'POST') {
        const auth = request.headers.get('Authorization');
        if (!auth) {return jsonResponse({ error: 'Unauthorized' }, 401);}
        const token = auth.split(' ')[1];
        const payload = await jwtVerify(token, env.JWT_SECRET);
        if (!payload || !payload.id || payload.id === 0) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
        await revokeAllUserRefreshTokens(env, payload.id);
        await logActivity(env, payload.id, 'logout_all_devices');
        return jsonResponse({ message: 'Logged out from all devices' });
      }

      return jsonResponse({ error: 'Route not found' }, 404);

    } catch (err) {
      console.error('auth error', err);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    }
  }
};
