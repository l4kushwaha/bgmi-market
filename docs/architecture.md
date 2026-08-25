# Architecture — BGMI Market

## Overview

Serverless microservice architecture. Every backend is a Cloudflare Worker (JavaScript)
persisting to Cloudflare D1 (SQLite). The frontend is a static site on Vercel. The only
"service mesh" element is a gateway Worker that routes `/api/<service>/<path>` to the
correct backend Worker and enforces JWT authentication on non-public routes.

Services communicate via **Cloudflare Service Bindings** (e.g. wallet → marketplace)
to avoid Error 1042 (worker-to-worker fetch on `*.workers.dev` is blocked).

## Component map

| Worker | Code | Routes | Data |
|--------|------|--------|------|
| Gateway | `gateway/hosting_cloudflare/index.js` | proxy `/api/<service>/...`, `/api/health`, `/api/admin/login` | — |
| Auth | `services/auth_service/hosting_cloudflare/index.js` | `/api/auth/{login,register,verify-email,refresh,forgot-password,reset-password}` | D1 `AUTH_DB` |
| Marketplace | `services/marketplace_service/hosting_cloudflare/index.js` | `/api/listings*`, `/api/seller/*` | D1 |
| Chat | `services/chat_service/hosting_cloudflare/index.js` | `/api/chat/{create,room,approve,half-payment,send,my,messages}` | D1 |
| Wallet | `services/wallet_service/index.js` | `/pay/service-charge`, `/pay/submit`, `/pay/release`, `/admin/earnings` | D1 + service binding → marketplace |
| Verification | `services/verification_service/hosting_cloudflare/index.js` | `/upload`, `/profile/*`, `/stats/*`, `/admin/{queue,decision,purge-kyc}` | D1 + R2 |

### Service bindings

```
wallet_service (wrangler.toml):
  [[services]]
  binding = "MARKETPLACE"
  service = "marketplace_service"
  entrypoint = "index.js"
```

## Request flow

1. Browser (Vercel) calls the gateway Worker: `https://<gateway>/api/<service>/<path>`.
2. Gateway validates the path against public routes; otherwise it requires
   `Authorization: Bearer <JWT>`.
3. Gateway forwards the request (method, headers, body, query) to the service Worker URL.
4. Service Worker reads the token (shared `JWT_SECRET`) for identity checks
   (ownership, admin role), queries D1, and returns JSON.

Services can also be called directly by their own worker URLs (the frontend currently
does this for some flows).

## Data model (D1)

- **users** — id, email (hashed password via bcryptjs), name, role, email_verified
- **password_resets** — otp_hash, expires_at, used
- **banned_users** — user_id, reason, banned_at
- **activity_log** — user_id, action, metadata, ip, created_at
- **refresh_tokens** — user_id, token_hash, expires_at, revoked
- **listings** — seller_id, uid, title, price, level, rank, item arrays (JSON), images, status
- **seller_stats** — seller_id, stars/badge, total_sales, total_revenue
- **reviews** — listing_id, stars, comment, reply
- **chat_rooms** — order_id, buyer_id, seller_user_id, status (requested/approved/half_paid/closed), intent (chat/buy)
- **messages** — room_id, sender_id, type, ciphertext, sensitive
- **service_payments** — order_id, buyer/seller ids, amounts, payee UPI, UTR, purpose, status
- **user_profiles** — user_id, name, gender, address, aadhaar_number (masked), pan_number, bio, upi_id, photo_url
- **kyc_documents** — user_id, document_type, document_key (R2), video_key (R2), liveness_result (JSON), verification_status, approved_at (used for 7-day purge)

## R2 storage

- `UPLOADS` bucket stores KYC document photos and video liveness recordings.
- Keys: `kyc_doc_{user_id}_{timestamp}`, `kyc_video_{user_id}_{timestamp}`.
- 7-day auto-purge: `POST /admin/purge-kyc` deletes R2 objects + DB rows where
  `datetime(approved_at, '+7 days') < datetime('now')`.

## Frontend security

- `app.js`: CryptoJS AES encryption via `Storage.prototype` shim — all sensitive
  localStorage keys (`token`, `user`, `refresh_token`) encrypted at rest.
- `auth.js`: `ssSet/ssGet/ssRemove` wrappers delegate to the same shim.
- Right-click disabled, Ctrl+C/U/S/F12 blocked outside inputs, devtools timing-guarded.
- All user-supplied content rendered via DOM (`createElement`/`textContent`) — no `innerHTML`.

## Deployment

- Backend: `npx wrangler deploy` per worker (auto on git push via Workers Git integration, or manual).
- Frontend: Vercel Git integration, root directory `frontend`.
- Secrets: `npx wrangler secret put <NAME> --name <worker>`.
