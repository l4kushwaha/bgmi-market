#!/usr/bin/env bash
# Demo flow for bgmi-market microservices (local)
# Assumes services are:
# gateway -> http://localhost
# auth -> http://localhost:5001
# market -> http://localhost:5002
# wallet -> http://localhost:5003
# admin -> http://localhost:5006
#
# Requires: curl, jq (jq optional but makes output nicer)

set -e

GATEWAY="http://localhost"
AUTH="$GATEWAY/api/auth"
MARKET="$GATEWAY/api/market"
WALLET="$GATEWAY/api/wallet"
ADMIN="$GATEWAY/api/admin"

echo "=== 0. Prereqs check ==="
command -v curl >/dev/null 2>&1 || { echo "curl required. abort."; exit 1; }
command -v jq >/dev/null 2>&1 || echo "warning: jq not found; outputs will be raw JSON."

echo
echo "=== 1. Register user (seller) ==="
REGISTER_RES=$(curl -s -X POST "$AUTH/register" -H "Content-Type: application/json" \
  -d '{"full_name":"Demo Seller","email":"seller@example.com","password":"sellerpass","phone":"9000000001"}')
echo "register response: $REGISTER_RES"

echo
echo "=== 2. Register buyer user ==="
BUYER_RES=$(curl -s -X POST "$AUTH/register" -H "Content-Type: application/json" \
  -d '{"full_name":"Demo Buyer","email":"buyer@example.com","password":"buyerpass","phone":"9000000002"}')
echo "register buyer response: $BUYER_RES"

echo
echo "=== 3. Login as seller to get token ==="
LOGIN_SELLER=$(curl -s -X POST "$AUTH/login" -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"sellerpass"}')
SELLER_TOKEN=$(echo "$LOGIN_SELLER" | jq -r '.token' 2>/dev/null || echo "")
echo "seller token: ${SELLER_TOKEN:0:40}... (truncated)"

echo
echo "=== 4. Login as buyer to get token ==="
LOGIN_BUYER=$(curl -s -X POST "$AUTH/login" -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"buyerpass"}')
BUYER_TOKEN=$(echo "$LOGIN_BUYER" | jq -r '.token' 2>/dev/null || echo "")
echo "buyer token: ${BUYER_TOKEN:0:40}... (truncated)"

echo
echo "=== 5. Seller: Create listing (list ID for sale) ==="
# Note: starter marketplace simulates seller_id, but we still call endpoint via gateway
LIST_RES=$(curl -s -X POST "$MARKET/list" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"uid":"10000001","title":"Ace Account - Mythic items","inventory":20000,"price":15000}')
echo "list create response: ${LIST_RES}"

echo
echo "=== 6. View marketplace listings ==="
curl -s "$MARKET/listings" | jq || echo "raw: $(curl -s $MARKET/listings)"

echo
echo "=== 7. Buyer: Purchase listing (creates escrow) ==="
# we assume listing id 1 (first created)
PURCHASE_RES=$(curl -s -X POST "$MARKET/buy" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -d '{"id":1}')
echo "purchase response: ${PURCHASE_RES}"

echo
echo "=== 8. Check wallet service: (list escrows) ==="
# Starter wallet service doesn't expose escrow list; show a quick check of /me (user 1) and admin wallet via small helper endpoints (if present).
echo "Wallet /me (user 1):"
curl -s "$WALLET/me" | jq || curl -s "$WALLET/me"

echo
echo "=== 9. Simulate admin release of escrow ==="
# In starter app /api/wallet/release expects escrow_id; assume escrow id 1
RELEASE_RES=$(curl -s -X POST "$WALLET/release" -H "Content-Type: application/json" \
  -d '{"escrow_id":1}')
echo "release response: ${RELEASE_RES}"

echo
echo "=== 10. Check AdminWallet balance (service charge) ==="
# Starter wallet doesn't expose admin via API; but we can try a debug endpoint if implemented.
# If not implemented, you can inspect wallet.db sqlite or add endpoint to wallet_service to fetch admin balance.
echo "If you have added admin view endpoint, call it. Otherwise inspect wallet.db for AdminWallet table."

echo
echo "=== DEMO COMPLETE ==="
echo "Notes:"
echo "- If any step failed: check service logs in terminal where you started the service."
echo "- If wallet release failed: ensure escrow id exists (inspect wallet.db using sqlite browser)."
