# API Reference — BGMI Market

All routes live on Cloudflare Workers. Base URLs (production):
`https://<worker-name>.bgmi-gateway.workers.dev`.

Auth convention: `Authorization: Bearer <access_token>` except where marked **public**.
Request/response bodies are JSON unless noted.

---

## Gateway worker

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| any | `/api/<service>/<path>` | varies | Proxy to the matching service worker. Public paths: `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/market/listings`, `/api/market/seller/*`. Everything else requires a JWT. |
| GET | `/api/health` | public | Health check. |
| GET | `/api/debug` | public | Debug info (URL, headers, service map). |
| POST | `/api/admin/login` | public | Admin login `{email, password}` → `{role:"admin", user}` (env-based credentials). |
| GET | `/api/test-cors` | public | CORS test. |

---

## Auth worker

### POST /api/auth/register — public
Body: `{ "username", "email", "password" }`
→ `200 { message, user:{id,email,role,name}, verify_required:true }`
- Validates email + password strength; rate-limited per IP.
- Sends OTP email; account remains unverified until OTP submitted.

### POST /api/auth/verify-email — public
Body: `{ "email", "otp" }` → `200 { access_token, refresh_token, user:{...} }`
- Verifies OTP, activates account, auto-logs in with fresh tokens.
- Brute-force guard: 6 failed attempts per account → 429 for 10 min.

### POST /api/auth/login — public
Body: `{ "email", "password" }`
→ `200 { access_token, refresh_token, user:{id,email,role,name} }`
- Admin credentials (env `ADMIN_EMAIL`/`ADMIN_PASSWORD`) log in as `role:"admin"`.

### POST /api/auth/refresh — public
Body: `{ "refresh_token" }` → `200 { access_token }`

### POST /api/auth/forgot-password — public
Body: `{ "email" }` → `200 { message }` (OTP generated, printed/logged in dev).

### POST /api/auth/reset-password — public
Body: `{ "otp", "new_password" }` → `200 { message }`

### GET /api/auth/health — public
→ `{ status:"ok", service:"auth" }`

---

## Marketplace worker

### GET /api/listings — public
Query: `?q=<search>&filter=<price_low|price_high|new|own>&limit=&offset=`
→ `200 [ Listing ]`

### POST /api/listings/create — auth (seller)
Body: `{ uid, title, price, level?, highest_rank?, mythic_items?, legendary_items?, gift_items?, upgraded_guns?, titles?, images?, description? }`
→ `201 { message, id }`

### PUT /api/listings/<id> — auth (owner or admin)
Body: any subset of listing fields → `200 { message }`

### DELETE /api/listings/<id> — auth (owner or admin)
→ `200 { message }`

### GET /api/seller/<seller_id> — public
→ `200 { user_id, name, avg_rating, review_count, seller_verified, total_sales, total_revenue, listings:[], reviews:[] }`

### GET /api/health — public

---

## Chat worker

### POST /api/chat/create — auth
Body: `{ order_id, seller_user_id, intent: "chat"|"buy" }`
→ `200 { room_id, status, intent, reused? }` (reuses an open room if present).

### GET /api/chat/room?room_id=<id> — auth (participant)
→ `200 { id, order_id, buyer_id, seller_user_id, status, intent, created_at, approved_at }`

### POST /api/chat/approve — auth (seller)
Body: `{ room_id, approve: bool }` → `200 { status: "approved"|"rejected" }`

### POST /api/chat/half-payment — auth (buyer)
Body: `{ room_id }` → `200 { status: "half_paid" }` (room must be `approved`).

### POST /api/chat/send — auth (participant, room `approved`/`half_paid`)
Body: `{ room_id, message, type?, sensitive? }` → `200 { status:"sent" }`

### GET /api/chat/my — auth
→ `200 [ { ...room, last_message } ]`

### GET /api/chat/messages?room_id=<id> — auth (participant)
→ `200 [ { id, room_id, sender_id, type, ciphertext, sensitive, created_at } ]`

---

## Wallet worker

### POST /pay/service-charge — auth
Body: `{ order_id, buyer_id?, seller_id, amount, purpose? }` (`purpose`: `full`|`half`)
→ `200 { payment_id, order_id, upi_id, upi_name, upi_amount, total_amount, status, purpose, direct_to_seller, note }`
Direct UPI (no gateway): payee is the seller's own UPI ID (from their profile) or the
platform fallback. The worker validates the `order_id` against the marketplace listing
(real listing, matching seller, amount = listing price for `full`).

### POST /pay/submit — auth
Body: `{ order_id, utr }`
→ `200 { message, status:"submitted" }`
UTR is sanitized + must be unique (one reference cannot confirm two payments).

### POST /pay/release — auth (admin)
Body: `{ order_id }`
→ `200 { message, seller_id, seller_amount }` (releases escrow to seller).

### GET /admin/earnings — auth (admin)
→ `200 { total_earnings }`

---

## Verification worker

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/upload` | auth | KYC: Aadhaar(12-digit)/PAN + doc photo + optional video liveness challenge. Body: FormData `{user_id, name, document_type, id_number, file, video?, liveness_result?}` → `{message, document_type, has_video, liveness_passed}`. Auto-rejects if liveness fails (422). |
| GET | `/profile/<user_id>` | auth | KYC/profile status. |
| POST | `/profile/update` | auth | Update profile fields. |
| GET | `/stats/<seller_id>` | auth | Seller stats. |
| GET | `/admin/queue` | auth (admin) | Pending KYC submissions (status='pending'). |
| POST | `/admin/decision` | auth (admin) | Approve/reject KYC. Sets `approved_at` on approval. |
| POST | `/admin/purge-kyc` | auth (admin) | Auto-delete Aadhaar + video from R2/DB 7 days after approval. |
| GET | `/health` | public | Health check. |

---

## Error format

Non-2xx responses use `{ "error": "<reason>" }`. Status codes: `400` bad input,
`401` missing/invalid token, `403` forbidden (not owner/admin), `404` not found,
`409` state conflict, `429` rate-limited, `502` upstream unavailable.
