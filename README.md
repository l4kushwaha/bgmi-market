# BGMI Market

A premium, serverless marketplace for buying & selling BGMI (Battlegrounds Mobile India) accounts with enterprise-grade security.

## ✨ Features

### 🛡️ Security First
- **JWT Authentication** with access/refresh tokens, rotation & revocation
- **Direct UPI Payments** — no payment gateway, no KYC, 10% platform fee
- **Secure Escrow** — admin verifies UTR before releasing funds
- **XSS Prevention** — DOM-based rendering, no `innerHTML` vulnerabilities
- **Rate Limiting** — per-endpoint, per-user, per-IP protection
- **Input Sanitization** — all user inputs validated & sanitized
- **Refresh Token Security** — rotation on use, revocation on logout/password change
- **Encrypted Session Storage** — AES-256-GCM at rest, no plaintext tokens in localStorage
- **Server-side Error Sanitization** — all 5 services strip error details from responses
- **OTP Brute-force Protection** — per-account rate limit (6 fails / 10 min)

### 💰 Payment Flow
1. Buyer creates purchase → escrow record created
2. Wallet service validates order server-side (listing exists, seller matches, amount matches)
3. Buyer pays via UPI directly to seller's UPI (or platform fallback)
4. Buyer submits UTR → admin verifies in UPI app
5. Admin releases escrow → seller receives 90%, platform keeps 10%
6. Seller withdraws to their UPI

### 🎮 Marketplace Features
- **Account Listings** — UID, level, rank, items, skins, titles
- **Popularity Boost** — sell popularity points with target UID
- **Verified Sellers** — KYC with guided liveness challenge (head movement), document verification
- **Real Meetups** — safe in-person exchange option
- **Built-in Chat** — voice messages, WebRTC calls, effects
- **Price Estimator** — server-synced pricing config

### 👤 User Experience
- **Dark/Light Mode** — persistent theme with system detection
- **Premium UI** — glassmorphism, animations, particle backgrounds
- **Responsive Design** — mobile-first, works on all devices
- **Toast Notifications** — real-time feedback
- **Skeleton Loaders** — perceived performance
- **Error Pages** — friendly 404/500 pages with details

---

## Architecture

```
Browser (Vercel)                    Cloudflare Workers
┌────────────────────────┐    HTTPS    ┌──────────────────────────────────┐
│ Frontend Pages         │ ──────────▶ │ API Gateway (bgmi-gateway)      │
│ index, login, market   │             │ proxies /api/<service>/...      │
│ sell, chat, wallet     │             └───────────┬──────────┬──────────┘
│ admin, profile         │                       │          │
└────────────────────────┘      ┌────────────────▼──┐   ┌────▼─────────────────┐
                                │ auth-service      │   │ bgmi-marketplace     │
                                │ (register/login/  │   │ (wallet, direct UPI) │
                                │  OTP/refresh)     │   ├──────────────────────┤
                                ├───────────────────┤   │ verification_service │
                                │ marketplace_svc   │   │ (KYC uploads)        │
                                │ (listings/sellers)│   └──────────────────────┘
                                ├───────────────────┤
                                │ chat_service      │
                                │ (buy rooms/chat)  │
                                └───────────────────┘
                        Each worker backed by its own D1 database
```

---

## Services

| Component | Location | Worker Name | Live URL |
|---|---|---|---|
| API Gateway | `gateway/hosting_cloudflare/` | `bgmi-gateway` | `https://bgmi-gateway.bgmi-gateway.workers.dev` |
| Auth (register/login/refresh/OTP) | `services/auth_service/hosting_cloudflare/` | `auth-service` | `https://auth-service.bgmi-gateway.workers.dev` |
| Marketplace (listings/sellers) | `services/marketplace_service/hosting_cloudflare/` | `bgmi_marketplace_service` | `https://bgmi_marketplace_service.bgmi-gateway.workers.dev` |
| Chat (buy requests/rooms) | `services/chat_service/hosting_cloudflare/` | `bgmi_chat_service` | `https://bgmi_chat_service.bgmi-gateway.workers.dev` |
| Wallet (direct UPI 10% fee) | `services/wallet_service/` | `bgmi-marketplace` | `https://bgmi-marketplace.bgmi-gateway.workers.dev` |
| Verification (KYC uploads) | `services/verification_service/hosting_cloudflare/` | `verification_service` | `https://verification_service.bgmi-gateway.workers.dev` |

> ⚠️ **Wallet worker name:** Deployed as `bgmi-marketplace` (not `bgmi-wallet-service`). Frontend and gateway use `https://bgmi-marketplace.bgmi-gateway.workers.dev`. Do not rename without updating all references.

---

## Repo Layout

```
gateway/hosting_cloudflare/       API gateway worker (proxy + health)
services/<service>/hosting_cloudflare/   One worker per service (index.js, wrangler.toml, schema.sql)
services/wallet_service/          Wallet worker (direct UPI)
docs/                             Architecture, API spec, security policies
frontend/                         Frontend source (vanilla HTML/CSS/JS)
tests/                            Unit tests (vitest)
```

> `frontend/` is deployed separately to Vercel from `bgmi-frontend` repo. This repo contains backend workers only.

---

## Local Development

### Prerequisites
- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account with Workers + D1 access

### Setup

```bash
# 1. Clone and install root dependencies
git clone <repo-url>
cd bgmi-market
npm install

# 2. Authenticate Wrangler
npx wrangler login

# 3. Create D1 databases (one per service)
npx wrangler d1 create auth_db
npx wrangler d1 create marketplace_db
npx wrangler d1 create chat_db
npx wrangler d1 create verification_db
npx wrangler d1 create wallet_db

# 4. Update wrangler.toml files with database_ids
# 5. Run migrations
cd services/auth_service/hosting_cloudflare && npx wrangler d1 migrations apply auth_db --local
cd services/marketplace_service/hosting_cloudflare && npx wrangler d1 migrations apply marketplace_db --local
cd services/chat_service/hosting_cloudflare && npx wrangler d1 migrations apply chat_db --local
cd services/verification_service/hosting_cloudflare && npx wrangler d1 migrations apply verification_db --local
cd services/wallet_service && npx wrangler d1 migrations apply wallet_db --local

# 6. Set secrets (see Secrets section below)

# 7. Start development servers
# Terminal 1: Auth service
cd services/auth_service/hosting_cloudflare && npx wrangler dev --port 8787

# Terminal 2: Marketplace service
cd services/marketplace_service/hosting_cloudflare && npx wrangler dev --port 8788

# Terminal 3: Chat service
cd services/chat_service/hosting_cloudflare && npx wrangler dev --port 8789

# Terminal 4: Verification service
cd services/verification_service/hosting_cloudflare && npx wrangler dev --port 8790

# Terminal 5: Wallet service
cd services/wallet_service && npx wrangler dev --port 8791

# Terminal 6: Gateway
cd gateway/hosting_cloudflare && npx wrangler dev --port 8786

# Terminal 7: Frontend (Vite/serve)
cd frontend && npx serve .
```

---

## Secrets Configuration

**Never commit secrets.** Set via Wrangler CLI or Cloudflare Dashboard.

### Required Secrets

```bash
# 1. JWT Secret (MUST be identical across ALL workers)
# Generate: openssl rand -base64 48
npx wrangler secret put JWT_SECRET --name auth-service
npx wrangler secret put JWT_SECRET --name bgmi_marketplace_service
npx wrangler secret put JWT_SECRET --name bgmi_chat_service
npx wrangler secret put JWT_SECRET --name verification_service
npx wrangler secret put JWT_SECRET --name bgmi-marketplace
npx wrangler secret put JWT_SECRET --name bgmi-gateway

# 2. Admin Credentials (auth-service + gateway)
npx wrangler secret put ADMIN_EMAIL --name auth-service
npx wrangler secret put ADMIN_PASSWORD --name auth-service
npx wrangler secret put ADMIN_EMAIL --name bgmi-gateway
npx wrangler secret put ADMIN_PASSWORD --name bgmi-gateway

# 3. Email Service (Brevo/Sendinblue for OTP)
npx wrangler secret put BREVO_API_KEY --name auth-service

# 4. Wallet Service
npx wrangler secret put ADMIN_UPI_ID --name bgmi-marketplace
npx wrangler secret put ADMIN_UPI_NAME --name bgmi-marketplace
npx wrangler secret put MARKETPLACE_URL --name bgmi-marketplace
```

### Admin Credentials

| Variable | Description | Example (PLACEHOLDER) |
|---|---|---|
| `ADMIN_EMAIL` | Admin login email | `your_email@example.com` |
| `ADMIN_PASSWORD` | Strong password (min 16 chars) | Set via secret |
| `JWT_SECRET` | 48+ char base64 string | `openssl rand -base64 48` |
| `BREVO_API_KEY` | Brevo SMTP API key | `xkeysib-...` |
| `ADMIN_UPI_ID` | Platform fallback UPI (when seller has none) | `pay@yourupi` |
| `ADMIN_UPI_NAME` | Display name for UPI | `BGMI Market` |
| `MARKETPLACE_URL` | Marketplace service URL | `https://bgmi_marketplace_service.bgmi-gateway.workers.dev` |

> ⚠️ **NEVER COMMIT REAL VALUES** — All secrets set via `wrangler secret put`
> - Admin UPI: Platform fallback when seller hasn't set their own UPI
> - Buyer pays admin UPI → admin verifies UTR → releases to seller

---

## Deployment

### Automatic (CI/CD)

Push to `main` branch triggers [GitHub Actions](.github/workflows/deploy.yml):

```yaml
# .github/workflows/deploy.yml
# Deploys all 6 workers via cloudflare/wrangler-action
# Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID secrets
```

### Manual Deployment

```bash
# Deploy each service (run from repo root)
cd services/auth_service/hosting_cloudflare && npx wrangler deploy
cd services/marketplace_service/hosting_cloudflare && npx wrangler deploy
cd services/chat_service/hosting_cloudflare && npx wrangler deploy
cd services/verification_service/hosting_cloudflare && npx wrangler deploy
cd services/wallet_service && npx wrangler deploy
cd gateway/hosting_cloudflare && npx wrangler deploy
```

### Frontend Deployment (Vercel)

1. Connect `bgmi-frontend` repo to Vercel
2. Set environment variables in Vercel dashboard
3. Push to main → auto-deploys

---

## API Reference

### Auth Service (`/api/auth/*`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/login` | Email/password login → returns access + refresh tokens |
| `POST` | `/register` | Register new user → sends verification OTP (auto-login on verify) |
| `POST` | `/verify-email` | Verify email with OTP → returns access + refresh tokens (auto-login) |
| `POST` | `/resend-verification` | Resend verification OTP |
| `POST` | `/refresh` | Rotate refresh token → new access + refresh |
| `POST` | `/logout` | Revoke refresh token |
| `POST` | `/logout-all` | Revoke all user's refresh tokens |
| `POST` | `/forgot-password` | Send password reset OTP |
| `POST` | `/reset-password` | Reset password with OTP |
| `GET` | `/me` | Get current user from access token |
| `GET` | `/health` | Health check |

### Marketplace Service (`/api/*`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/listings` | List all available listings (with filters) |
| `GET` | `/listings/:id` | Get single listing |
| `POST` | `/listings/create` | Create new listing (auth required) |
| `PUT` | `/listings/:id` | Update listing (owner/admin) |
| `DELETE` | `/listings/:id` | Delete listing (owner/admin) |
| `POST` | `/purchases` | Create purchase (buyer) |
| `GET` | `/purchases/my` | Get user's purchases |
| `POST` | `/reviews` | Create review (buyer) |
| `GET` | `/seller/:id` | Get seller profile |
| `POST` | `/seller/verify-request` | Request seller verification |
| `GET` | `/price-config` | Get pricing configuration |
| `PUT` | `/admin/price-config` | Update pricing (admin) |

### Wallet Service (`/*`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/pay/service-charge` | Create payment intent (10% fee) |
| `POST` | `/pay/submit` | Submit UTR after UPI payment |
| `POST` | `/pay/release` | Admin: release escrow to seller |
| `GET` | `/balance` | Get seller balance |
| `POST` | `/withdraw` | Request withdrawal |
| `GET` | `/withdrawals` | Get withdrawal history |
| `GET` | `/admin/earnings` | Admin: earnings report |
| `GET` | `/admin/payments` | Admin: all payments |
| `GET` | `/admin/withdrawals` | Admin: withdrawal queue |
| `POST` | `/admin/withdrawals/:id` | Admin: process/reject withdrawal |
| `GET` | `/admin/balances` | Admin: all seller balances |
| `GET` | `/admin/settings` | Get platform UPI settings |
| `PUT` | `/admin/settings` | Update platform UPI settings |

### Chat Service (`/api/chat/*`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/create` | Create chat/buy room |
| `GET` | `/room` | Get room details |
| `POST` | `/approve` | Seller approve/reject room |
| `POST` | `/half-payment` | Buyer confirm half payment |
| `POST` | `/send` | Send message (text/voice) |
| `GET` | `/my` | Get user's chat rooms |
| `GET` | `/messages` | Get room messages |
| `GET` | `/global/channels` | Get global chat channels |
| `GET` | `/global/messages` | Get global messages |
| `POST` | `/global/send` | Send global message |

### Verification Service (`/*`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/upload` | Submit KYC: Aadhaar(12-digit)/PAN + doc photo + optional video liveness |
| `GET` | `/seller/upi/:id` | Get seller's UPI (for direct payment) |
| `GET` | `/profile/:id` | Get user profile |
| `POST` | `/profile/update` | Update profile (UPI, bio, social) |
| `GET` | `/stats/:id` | Get seller stats |
| `GET` | `/admin/queue` | Admin: KYC review queue |
| `POST` | `/admin/decision` | Admin: approve/reject KYC (sets approved_at for 7-day purge) |
| `POST` | `/admin/purge-kyc` | Admin: delete Aadhaar + video from DB/R2 after 7 days |

---

## Security Checklist

✅ **Implemented:**
- JWT with `type: "access" | "refresh"` claims
- Refresh token rotation on every use
- Refresh token revocation on logout/password change
- Refresh token storage with SHA-256 hashing
- Rate limiting on all sensitive endpoints
- UTR uniqueness validation (prevents replay attacks)
- Input sanitization (XSS prevention)
- SQL injection prevention (parameterized queries)
- CORS with exact origin matching
- Security headers (CSP, HSTS, X-Frame-Options, etc.)
- Admin-only endpoints protected by role check
- Password reset revokes all sessions
- OTP rate limiting (email + IP)

⚠️ **To Implement:**
- [ ] Webhook notifications for payment events
- [ ] Audit logging for all admin actions
- [ ] 2FA for admin accounts
- [ ] Automated D1 migration system
- [ ] Real-time face-match (currently skin-tone + head movement liveness)

---

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Test Structure
```
tests/
├── auth.test.js          # JWT, rate limiting, OTP, validation
├── marketplace.test.js   # Listings, purchases, reviews, sellers
├── wallet.test.js        # UPI, UTR, escrow, withdrawals
└── (frontend tests removed - run in browser)
```

---

## Scripts

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "lint": "eslint . --ext .js,.mjs",
  "lint:fix": "eslint . --ext .js,.mjs --fix"
}
```

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|---|---|
| `JWT_SECRET` mismatch | Ensure **identical** secret across all 6 workers |
| CORS errors | Check `ALLOWED_ORIGINS` in gateway; must match frontend URL |
| D1 migrations fail | Run `npx wrangler d1 migrations apply <db> --local` first |
| OTP emails not sending | Verify `BREVO_API_KEY` secret; check Brevo dashboard |
| UPI payment stuck | Check admin UPI settings in wallet service |
| Refresh token invalid | User must login again (token rotated/revoked) |

### Debug Commands

```bash
# Check worker logs
npx wrangler tail auth-service

# Test D1 queries locally
npx wrangler d1 execute auth_db --local --command "SELECT * FROM users"

# Verify secrets
npx wrangler secret list --name auth-service
```

---

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Run tests: `npm test`
4. Run linter: `npm run lint:fix`
5. Commit changes: `git commit -m 'feat: add amazing feature'`
6. Push to branch: `git push origin feature/amazing-feature`
7. Open Pull Request

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Disclaimer

**BGMI Market is not affiliated with, endorsed by, or connected to Krafton Inc., PUBG Corporation, or Battlegrounds Mobile India.** This is an independent marketplace for virtual goods trading.

---

## Support

- 📧 Email: `support@bgmimarket.com`
- 💬 Discord: [Join our server](https://discord.gg/bgmi-market)
- 🐛 Issues: [GitHub Issues](https://github.com/your-org/bgmi-market/issues)
- 📖 Docs: [Full Documentation](https://docs.bgmimarket.com)