# BGMI Market

A serverless marketplace for buying & selling BGMI (Battlegrounds Mobile India) accounts.

- **Backend** — Cloudflare Workers + D1 (SQLite), pure JavaScript
- **Frontend** — Vanilla HTML / CSS / JS, deployed on Vercel from the separate [`bgmi-frontend`](https://github.com/l4kushwaha/bgmi-frontend) repo
- **Payments** — Razorpay (10% service charge)
- **Auth** — JWT (access + refresh) with email OTP password reset

No Python, no local runtime required. Everything is fully serverless.

---

## Architecture

```
Browser (Vercel — bgmi-frontend repo)        Cloudflare (workers.dev)
┌────────────────────────────┐   HTTPS   ┌──────────────────────────────────┐
│ frontend/*                 │ ─────────▶ │ gateway (bgmi-gateway)          │
│  index, login, marketplace │            │  proxies /api/<service>/...     │
│  sell, chat, wallet, admin │            └───────────┬──────────┬──────────┘
└────────────────────────────┘                       │          │
                               ┌─────────────────────▼──┐   ┌───▼─────────────────┐
                               │ auth-service           │   │ bgmi_marketplace    │
                               │ (register/login/OTP)   │   │ (wallet, Razorpay)  │
                               ├────────────────────────┤   ├─────────────────────┤
                               │ bgmi_marketplace_      │   │ verification_service│
                               │ service (listings)     │   │ (KYC uploads)       │
                               ├────────────────────────┤   └─────────────────────┘
                               │ bgmi_chat_service      │
                               │ (buy rooms / chat)     │
                               └────────────────────────┘
                      each worker backed by its own D1 database
```

## Services

| Component | Location | Worker name (deploy) | Live URL |
|---|---|---|---|
| API Gateway | `gateway/hosting_cloudflare/` | `bgmi-gateway` | https://bgmi-gateway.bgmi-gateway.workers.dev |
| Auth (register/login/refresh/OTP) | `services/auth_service/hosting_cloudflare/` | `auth-service` | https://auth-service.bgmi-gateway.workers.dev |
| Marketplace (listings/sellers) | `services/marketplace_service/hosting_cloudflare/` | `bgmi_marketplace_service` | https://bgmi_marketplace_service.bgmi-gateway.workers.dev |
| Chat (buy requests/rooms) | `services/chat_service/hosting_cloudflare/` | `bgmi_chat_service` | https://bgmi_chat_service.bgmi-gateway.workers.dev |
| Wallet (Razorpay 10% fee) | `services/wallet_service/` | `bgmi-marketplace` | https://bgmi-marketplace.bgmi-gateway.workers.dev |
| Verification (KYC uploads) | `services/verification_service/hosting_cloudflare/` | `verification_service` | https://verification_service.bgmi-gateway.workers.dev |

> ⚠️ **Wallet worker name:** the wallet worker is deployed as `bgmi-marketplace`, **not** `bgmi-wallet-service`. The frontend and gateway use `https://bgmi-marketplace.bgmi-gateway.workers.dev`. Do not rename workers without updating all references.

## Repo layout

```
gateway/hosting_cloudflare/       API gateway worker (proxy + health + admin login)
services/<service>/hosting_cloudflare/   one worker per service (index.js, wrangler.toml, schema.sql)
services/wallet_service/          wallet worker (Razorpay)
docs/                             architecture, API spec, security policies
frontend/                         frontend source — IGNORED here, managed by bgmi-frontend repo
```

> `frontend/` is its own git repo (`l4kushwaha/bgmi-frontend`) connected to Vercel.
> Pushing there auto-deploys the site. This repo contains only the backend workers.

## Local development

Requires [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
# 1. Authenticate
npx wrangler login

# 2. Run one worker locally (example: auth)
cd services/auth_service/hosting_cloudflare
npm install
npx wrangler dev
```

D1 local state is created under `.wrangler/` (git-ignored). Use the **same `JWT_SECRET`**
across all workers so tokens are interchangeable.

## Deploy

### Automatic (CI)

Push to `main` → [GitHub Actions](.github/workflows/deploy.yml) deploys every worker
with `cloudflare/wrangler-action`. Requires the `CLOUDFLARE_API_TOKEN` repository secret
(a Cloudflare token with *Worker Scripts: Edit* + *D1: Edit* permissions).

### Manual

```bash
# One per service
cd services/auth_service/hosting_cloudflare && npx wrangler deploy
cd services/marketplace_service/hosting_cloudflare && npx wrangler deploy
cd services/chat_service/hosting_cloudflare && npx wrangler deploy
cd services/verification_service/hosting_cloudflare && npx wrangler deploy
cd services/wallet_service && npx wrangler deploy
cd gateway/hosting_cloudflare && npx wrangler deploy
```

### Secrets (set once, never commit)

```bash
npx wrangler secret put JWT_SECRET --name auth-service
npx wrangler secret put JWT_SECRET --name bgmi_marketplace_service
npx wrangler secret put JWT_SECRET --name bgmi_chat_service
npx wrangler secret put JWT_SECRET --name verification_service
npx wrangler secret put JWT_SECRET --name bgmi-marketplace

npx wrangler secret put ADMIN_EMAIL --name auth-service
npx wrangler secret put ADMIN_PASSWORD --name auth-service
npx wrangler secret put ADMIN_EMAIL --name bgmi-gateway
npx wrangler secret put ADMIN_PASSWORD --name bgmi-gateway

npx wrangler secret put BREVO_API_KEY --name auth-service

npx wrangler secret put RAZORPAY_KEY_ID --name bgmi-marketplace
npx wrangler secret put RAZORPAY_KEY_SECRET --name bgmi-marketplace
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — system design & data flow
- [`docs/api_spec.md`](docs/api_spec.md) — full API reference
- [`docs/security_policies.md`](docs/security_policies.md) — security notes & secrets
- [`.env.example`](.env.example) — environment variable reference

## Known issues / next steps

- **Wallet/chat payment flow is not end-to-end wired**: the wallet worker exists and
  verifies Razorpay signatures, but the frontend buy/chat flow does not pass a real
  `buyer_id`/`amount` and no Razorpay checkout is shown. `wallet.js` also expects a
  `localStorage.activeRoom` that nothing sets.
- **Schema/code drift**: some `schema.sql` files don't match what the worker code
  queries (`rate_limits`, `password_resets`, `sellers`, `chat_rooms`, `service_payments`).
  Migrations must be reconciled and applied with `wrangler d1 migrations apply`.
- **Fake KYC**: `verification_service` marks every upload as verified with hardcoded
  demo data. Replace with real OCR/face-match or at least admin approve/reject.
- **No auth on wallet/verification workers**: anyone can hit them today. Add JWT
  verification before production use.
- **Stored XSS**: `frontend/js/marketplace.js` renders listing fields via `innerHTML`.
  Escape or use `textContent`.
- **Refresh tokens** are not rotated/revoked and lack a `type: "refresh"` claim.
