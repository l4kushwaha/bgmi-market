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
- Registration flow: register → verify email with OTP → auto-login (tokens returned on verify).
- OTP brute-force guard: max 6 failed attempts per account → 429 locked for 10 minutes.
- Banned accounts rejected at login and email-verify (checked against `banned_users` table).
- Refresh tokens are rotated on every use and revoked on logout / password change.

## 3. Encrypted session store (frontend)

- All sensitive localStorage keys (`token`, `user`, `refresh_token`) are encrypted at rest
  via CryptoJS AES applied transparently through a `Storage.prototype` shim in `app.js`.
- auth.js uses `ssSet/ssGet/ssRemove` wrappers that delegate to the same shim — no plaintext
  tokens exist in localStorage.
- Site-wide protections: right-click disabled, Ctrl+C/U/S/F12 blocked outside form inputs,
  devtools timing-guarded via debugger trip.

## 4. Authorization (role & ownership)

- Admin-only endpoints (`/api/admin/*`, wallet `/admin/earnings`) require
  `role === "admin"` and reject otherwise (403).
- Listing edit/delete: only the listing owner **or** an admin.
- Chat room access: only the buyer or seller of that room.
- All ownership checks compare the token identity, never trust client-sent ids alone.

## 5. Input validation & rate limiting

- Email format + password strength (min length, complexity) validated at register/reset.
- Auth endpoints are IP rate-limited (login, register, OTP requests).
- Payment endpoints: the wallet worker validates every `/pay/service-charge` order
  server-side against the marketplace listing (real listing, matching seller, exact
  amount for full payment), rate-limits intents & UTR submissions, and rejects reused
  UTR numbers. Payee UPI is resolved server-side from the seller's profile — never
  taken from the client.
- Marketplace/chat validate required fields and numeric types; unknown ids return 404.
- KYC upload validates document type (Aadhaar 12-digit / PAN ABCDE1234F), file size limits,
  and video liveness result — auto-rejects if liveness check fails (422).

## 6. KYC & data protection

- KYC submission requires: document type, ID number (validated server-side), document photo
  (R2 storage), and optional video liveness challenge (head movement prompts).
- Liveness result `{passed, face_detected, prompts_completed}` stored as JSON in `kyc_documents`;
  auto-rejected server-side if `result === 'fail'` or face ratio < 60%.
- **7-day data purge**: Aadhaar number masked as `XXXX-XXXX-XXXX` on submission; full document
  photo + video deleted from R2 and `kyc_documents` row removed 7 days after admin approval.
  Triggered by `POST /admin/purge-kyc`.
- Passwords hashed with bcryptjs before storage — never stored in plain text.
- OTPs stored only as hashes with expiry (`used` flag prevents replay).
- All worker error responses are sanitized — no `err.message` leakage to clients;
  full errors logged server-side only.

## 7. CORS & gateway

- Gateway worker sets a strict `Access-Control-Allow-Origin` (the Vercel frontend
  origin only), not `*`.
- Public gateway paths are allow-listed; everything else requires a JWT.
- The gateway forwards the original `Authorization` header and never logs tokens.

## 8. Service bindings

- Wallet → Marketplace: uses Cloudflare service binding (`env.MARKETPLACE.fetch()`)
  instead of direct fetch to `*.workers.dev` (blocked by Error 1042).
- Each worker's `wrangler.toml` declares its service bindings; production IDs set via
  `npx wrangler secret put`.

## 9. Production checklist

- [x] Rotate `JWT_SECRET` and move it to `wrangler secret put`.
- [x] Move admin credentials out of `wrangler.toml` into secrets.
- [x] Set `ADMIN_UPI_ID` / `ADMIN_UPI_NAME` on the wallet worker (platform fallback payee).
- [x] Enforce HTTPS on all worker routes and the Vercel app.
- [x] Deploy all 5 services with sanitized error responses.
- [ ] Rotate the sample D1 database ids if they map to real data.
- [ ] Run `wrangler secret list` per worker to confirm only intended secrets exist.
- [ ] Set up D1 backup schedule or point-in-time recovery.
