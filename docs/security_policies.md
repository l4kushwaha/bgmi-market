# Security Policies — BGMI Market

## 1. Secrets management

- Never commit real secrets. `.gitignore` blocks `.env*` (except `.env.example`).
- Worker runtime secrets must be set with:
  `npx wrangler secret put <NAME> --name <worker>` (JWT_SECRET, ADMIN_UPI_ID, admin credentials…).
- `wrangler.toml` files contain **no secrets** — only placeholders/comments. Never add
  real secrets to `wrangler.toml`; use `wrangler secret put` instead.

## 2. Authentication & tokens

- Access + refresh tokens are JWT (HS256) signed with a **single shared `JWT_SECRET`**
  used by every worker, so any worker can verify tokens issued by the auth worker.
- `access_token`: short-lived (minutes). `refresh_token`: long-lived, type `refresh`,
  used only at `/api/auth/refresh`.
- Tokens carry `{ id, email, role }`. The marketplace/chat workers map `id` → the
  acting user for ownership checks (`seller_id` / `buyer_id`).
- Never store the token in a cookie without `Secure; HttpOnly; SameSite`.

## 3. Authorization (role & ownership)

- Admin-only endpoints (`/api/admin/*`, wallet `/admin/earnings`) require
  `role === "admin"` and reject otherwise (403).
- Listing edit/delete: only the listing owner **or** an admin.
- Chat room access: only the buyer or seller of that room.
- All ownership checks compare the token identity, never trust client-sent ids alone.

## 4. Input validation & rate limiting

- Email format + password strength (min length, complexity) validated at register/reset.
- Auth endpoints are IP rate-limited (login, register, OTP requests).
- Payment endpoints: the wallet worker validates every `/pay/service-charge` order
  server-side against the marketplace listing (real listing, matching seller, exact
  amount for full payment), rate-limits intents & UTR submissions, and rejects reused
  UTR numbers. Payee UPI is resolved server-side from the seller's profile — never
  taken from the client.
- Marketplace/chat validate required fields and numeric types; unknown ids return 404.

## 5. Data protection

- Passwords hashed with bcryptjs before storage — never stored in plain text.
- OTPs stored only as hashes with expiry (`used` flag prevents replay).
- Message `ciphertext` field supports client-side encryption for sensitive content;
  keep `sensitive: true` for anything private.
- D1 databases: do not back up into the repo; backups go to encrypted storage.

## 6. CORS & gateway

- Gateway worker sets a strict `Access-Control-Allow-Origin` (the Vercel frontend
  origin only), not `*`.
- Public gateway paths are allow-listed; everything else requires a JWT.
- The gateway forwards the original `Authorization` header and never logs tokens.

## 7. Production checklist

- [ ] Rotate `JWT_SECRET` and move it to `wrangler secret put`.
- [ ] Move admin credentials out of `wrangler.toml` into secrets.
- [ ] Set `ADMIN_UPI_ID` / `ADMIN_UPI_NAME` on the wallet worker (platform fallback payee).
- [ ] Rotate the sample D1 database ids if they map to real data.
- [ ] Enforce HTTPS on all worker routes and the Vercel app.
- [ ] Run `wrangler secret list` per worker to confirm only intended secrets exist.
