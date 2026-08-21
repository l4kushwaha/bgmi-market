// Google / Facebook se login — OAuth 2.0 flow
// Keys daalne ke baad ye khud chalu ho jayega:
//   wrangler secret put GOOGLE_CLIENT_ID
//   wrangler secret put GOOGLE_CLIENT_SECRET
//   wrangler secret put FACEBOOK_CLIENT_ID
//   wrangler secret put FACEBOOK_CLIENT_SECRET

function jr(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
  });
}

export async function oauthStart(env, provider, origin) {
  const cid = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.FACEBOOK_CLIENT_ID;
  if (!cid) {
    return jr({
      error: 'not_configured',
      hint: provider + ' keys set nahi hui — wrangler secret put ' + provider.toUpperCase() + '_CLIENT_ID'
    }, 501);
  }
  const redirect = origin + '/api/auth/oauth/' + provider + '/callback';
  const state = crypto.randomUUID().replace(/-/g, '');
  const u = provider === 'google'
    ? 'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + cid +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&response_type=code&scope=openid%20email%20profile&state=' + state + '&prompt=select_account'
    : 'https://www.facebook.com/v19.0/dialog/oauth?client_id=' + cid +
      '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state + '&scope=email';
  return Response.redirect(u, 302);
}

export async function oauthCallback(env, provider, url, origin) {
  try {
    const code = url.searchParams.get('code');
    if (!code) return jr({ error: 'no_code' }, 400);

    const cid = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.FACEBOOK_CLIENT_ID;
    const csec = provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.FACEBOOK_CLIENT_SECRET;
    if (!csec) return jr({ error: 'not_configured' }, 501);

    const redirect = origin + '/api/auth/oauth/' + provider + '/callback';

    // code ko access token ke liye exchange karo
    const tr = await fetch(
      provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: cid, client_secret: csec,
          redirect_uri: redirect, grant_type: 'authorization_code'
        })
      }
    );
    const tj = await tr.json();
    if (!tj.access_token) return jr({ error: 'token_exchange_failed', detail: tj }, 401);

    // profile nikalo
    let email, name;
    if (provider === 'google') {
      const pr = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tj.access_token }
      });
      const pj = await pr.json();
      email = pj.email;
      name = pj.name || (email || 'user').split('@')[0];
    } else {
      const pr = await fetch('https://graph.facebook.com/me?fields=id,name,email&access_token=' + tj.access_token);
      const pj = await pr.json();
      email = pj.email;
      name = pj.name || ('fb_' + pj.id);
    }
    if (!email) return jr({ error: 'provider_ne_email_nahi_diya' }, 400);

    // pehle se user hai ya naya banao
    email = email.toLowerCase();
    let row = await env.AUTH_DB.prepare('SELECT id,email,username,role,status FROM users WHERE email=?1')
      .bind(email).first();
    if (!row) {
      await env.AUTH_DB.prepare(
        "INSERT INTO users(email,username,password_hash,role,status,email_verified) VALUES(?1,?2,?3,'user','active',1)"
      ).bind(email, name.slice(0, 20), 'oauth:' + crypto.randomUUID()).run();
      row = await env.AUTH_DB.prepare('SELECT id,email,username,role,status FROM users WHERE email=?1')
        .bind(email).first();
    }
    if (row.status === 'banned') return jr({ error: 'Account banned' }, 403);

    // token bana ke frontend par bhejo
    const secret = env.JWT_SECRET || 'dev-secret-change-me';
    const access = await jwtSignLocal({ sub: row.id, email: row.email, role: row.role }, secret, '7d');
    const refresh = await jwtSignLocal({ sub: row.id, type: 'refresh' }, secret, '30d');

    const fe = 'https://bgmi-frontend.vercel.app/index.html';
    const frag = '#access=' + encodeURIComponent(access) +
      '&refresh=' + encodeURIComponent(refresh) +
      '&user=' + encodeURIComponent(JSON.stringify({ id: row.id, email: row.email, name: row.username }));
    return Response.redirect(fe + frag, 302);
  } catch (e) {
    return jr({ error: e.message }, 500);
  }
}

// chhota HMAC-SHA256 JWT (index.js wale jaisa hi)
async function jwtSignLocal(payload, secret, expires) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = expires === '7d' ? now + 7 * 86400 : now + 30 * 86400;
  const body = { ...payload, iat: now, exp };
  const enc = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = enc(header) + '.' + enc(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
