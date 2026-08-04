# Architecture — BGMI Market

## Overview

Serverless microservice architecture. Every backend is a Cloudflare Worker (JavaScript)
persisting to Cloudflare D1 (SQLite). The frontend is a static site on Vercel. The only
"service mesh" element is a gateway Worker that routes `/api/<service>/<path>` to the
correct backend Worker and enforces JWT authentication on non-public routes.

## Component map

| Worker | Code | Routes | Data |
|--------|------|--------|------|
| Gateway | `gateway/hosting_cloudflare/index.js` | proxy `/api/<service>/...`, `/api/health`, `/api/admin/login` | — |
| Auth | `services/auth_service/hosting_cloudflare/index.js` | `/api/auth/{login,register,refresh,forgot-password,reset-password}` | D1 `AUTH_DB` |
| Marketplace | `services/marketplace_service/hosting_cloudflare/index.js` | `/api/listings*`, `/api/seller/*` | D1 |
| Chat | `services/chat_service/hosting_cloudflare/index.js` | `/api/chat/{create,room,approve,half-payment,send,my,messages}` | D1 |
| Wallet | `services/wallet_service/index.js` | `/pay/service-charge`, `/pay/submit`, `/pay/release`, `/admin/earnings` | D1 (direct UPI, no gateway) |
| Verification | `services/verification_service/hosting_cloudflare/index.js` | `/upload`, `/profile/*`, `/profile/update`, `/stats/*` | D1 + R2 |

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

- **users** — id, email (hashed password via bcryptjs), name, role
- **password_resets** — otp_hash, expires_at, used
- **listings** — seller_id, uid, title, price, level, rank, item arrays (JSON), images, status
- **sellers** — user_id, stars/badge, total_sales, total_revenue
- **reviews** — listing_id, stars, comment, reply
- **chat_rooms** — order_id, buyer_id, seller_user_id, status (requested/approved/half_paid/closed), intent (chat/buy)
- **messages** — room_id, sender_id, type, ciphertext, sensitive
- **service_payments** — order_id, buyer/seller ids, amounts, payee UPI, UTR, purpose, status
- **kyc / verification** — user_id, status, id_image (R2 key)

## Deployment

- Backend: `npx wrangler deploy` per worker (auto on git push via Workers Git integration, or manual).
- Frontend: Vercel Git integration, root directory `frontend`.
- Secrets: `npx wrangler secret put <NAME> --name <worker>`.
