# Shopee Open Platform v2 adapter

Implements `IMarketplaceChannelAdapter` for Shopee (`marketplace = 'SHOPEE'`).
Everything is dependency-injected through `AdapterDependencies` - the adapter
never instantiates Prisma/Redis/S3/HTTP itself.

```
index.ts                         factory + public exports (createShopeeChannelAdapter, diagnose helpers)
ShopeeChannelAdapter.ts          composition root, executeAction dispatcher, validateOutbound/resolveRoute
client/sign.ts                   HMAC-SHA256 signing + webhook signature + clock-skew guard (pure)
client/ShopeeClient.ts           signed HTTP calls, rate limit, error mapping, one-shot token retry
client/ShopeeAuth.ts             token cache, single-use refresh under Redlock, OAuth onboarding helpers
inbound/ShopeeWebhookParser.ts   full-URL + "|" + rawBody signature, timestamp tolerance, account lookup
inbound/ShopeeHydrator.ts        push triage, order/tracking/item enrichment, sticky routing, CRR metadata
outbound/ShopeeChat.ts           text/image/order-card/item-card sends + read_conversation CRR guarantee
outbound/ShopeeReturns.ts        returns confirm/dispute + buyer-cancellation accept
ShopeeMaintenance.ts             token rotation + lost-push recovery (official v2 contract)
ShopeeDiagnostics.ts             live diagnose() checks (real signed get_shop_info, clock skew)
mappers.ts / types.ts            pure normalization, triage matrix, API paths and DTOs
__tests__/                       pure unit tests (signing vectors, triage matrix, diagnose mapping)
```

## Sandbox vs production

`SHOPEE_API_BASE` selects the environment (no code change required):

| Environment | `SHOPEE_API_BASE` |
|---|---|
| Production (Global) | `https://partner.shopeemobile.com` |
| Production (Brazil) | `https://openplatform.shopee.com.br` |
| Production (Chinese mainland) | `https://openplatform.shopee.cn` |
| Sandbox (Global) | `https://openplatform.sandbox.test-stable.shopee.sg` |
| Sandbox (legacy / API console) | `https://partner.test-stable.shopeemobile.com` |
| Sandbox (Chinese mainland) | `https://openplatform.test-stable.shopee.cn` |

Shopee Brazil stores must use the Brazil production base (the global base also
works for most `v2.*` reads, but the BR host is the documented address for the BR
region). Sandbox app credentials (`partner_id`/`partner_key`) are different from
production; configure both in `.env` and restart the API/workers.
`diagnose()` reports a `shopee.sandbox` check (`warn`, with remediation) whenever
the configured base points at a `test-stable` host, plus `ok` for the documented
production hosts and `warn` for unknown hosts - so the cockpit never confuses a
sandbox run with a production store.

## Live diagnostics (`diagnose({ accountId })`)

Performs only real calls and never simulates success:

| check | what it does |
|---|---|
| `shopee.config` | validates `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_REDIRECT_URI`, `SHOPEE_API_BASE` (https) |
| `shopee.clock` | derives clock skew from the authoritative HTTP `Date` header (limit ±300 s; NTP remediation) |
| `shopee.token` | ensures a valid access token through the existing `shopeeRefreshLock` path |
| `shopee.sign` | local deterministic HMAC vector (bytes/lowercase hex) |
| `shopee.shop_info` | signed `GET /api/v2/shop/get_shop_info` (`partner_id`, `timestamp`, `access_token`, `shop_id`, `sign`) |
| `shopee.lost_push` | signed **public** `GET /api/v2/push/get_lost_push_message` when `SHOPEE_DIAGNOSE_LOST_PUSH=true` (read-only, never confirms/consumes; works even when the store token is broken) |
| `shopee.sandbox` | `ok` for documented production hosts, `warn` for `test-stable` sandbox or an unknown host |

The only write performed by diagnose is the single-use refresh-token rotation
required when the stored token is expired/invalid - it happens inside the same
Redlock used by normal traffic. No ticket/message/order/chat data is modified.

## Official conformance notes (open.shopee.com)

Verified against the Shopee v2 API (`v2.*` endpoints, `open.shopee.com` docs and
the official SDKs). Signature is always
`HMAC-SHA256(partner_id + api_path + timestamp + access_token + shop_id, partner_key)`
as lowercase hex, with the path only (`/api/v2/...`) and unix-second timestamp.

| Operation | Method + path | Params |
|---|---|---|
| Code exchange | `POST /api/v2/auth/token/get` | body `{ code, shop_id, partner_id }` |
| Refresh (single-use) | `POST /api/v2/auth/access_token/get` | body `{ refresh_token, shop_id, partner_id }` (falls back to `token/get` on 404/405 for older deployments) |
| Store authorization URL | `GET /api/v2/shop/auth_partner` | `partner_id`, `redirect`, `timestamp`, `sign` |
| Shop info | `GET /api/v2/shop/get_shop_info` | signed query only; response fields are flat (`shop_name`, `region`, `status`) |
| Chat send | `POST /api/v2/sellerchat/send_message` | body `{ to_id, message_type, content }` |
| Chat image upload | `POST /api/v2/sellerchat/upload_image` | multipart field `file` |
| Chat read (CRR) | `POST /api/v2/sellerchat/read_conversation` | body `{ conversation_id, last_read_message_id }` |
| Chat history | `GET /api/v2/sellerchat/get_message` | query `conversation_id`, `offset`, `page_size` |
| Order detail | `GET /api/v2/order/get_order_detail` | query `order_sn_list` (comma separated), `response_optional_fields` |
| Tracking | `GET /api/v2/logistics/get_tracking_info` | query `order_sn` (+ `package_number`) |
| Item base info | `GET /api/v2/product/get_item_base_info` | query `item_id_list` repeated (`int64[]`, e.g. `item_id_list=1&item_id_list=2`) |
| Return detail | `GET /api/v2/returns/get_return_detail` | query `return_sn` |
| Return dispute reasons | `GET /api/v2/returns/get_return_dispute_reason` | query `return_sn`; returns `dispute_reason_list[].evidence_module_list[]` |
| Return confirm | `POST /api/v2/returns/confirm` | body `{ return_sn }` |
| Return dispute | `POST /api/v2/returns/dispute` | body `{ return_sn, email, dispute_reason_id, image_list[]{ module_index, requirement, image_url[] }, dispute_text_reason }` (legacy `dispute_reason`/`image` were sunset by Shopee; max 3 images per module) |
| Buyer cancellation | `POST /api/v2/order/handle_buyer_cancellation` | body `{ order_sn, operation: 'ACCEPT' }` |
| Lost pushes | `GET /api/v2/push/get_lost_push_message` | **public** (partner_id/timestamp/sign only), no request params; response `push_message_list`/`has_next_page`/`last_message_id`; `data` is a JSON string |
| Lost pushes ack | `POST /api/v2/push/confirm_consumed_lost_push_message` | **public**, body `{ last_message_id }` |

Known divergences kept on purpose (binding project contracts):

- The SAC push triage matrix (`CHANNEL_CONTRACTS.md`) maps webhook `code` values
  to `sellerchat`/`order`/`returns`/`cancellation`, while the public Shopee push
  list uses different numbers (webchat `10`, order status `3`, tracking `4`,
  shop-authorization `1`/`2`, item/promotion `5`-`9`, ...). The hydrator dispatches
  on the **payload shape first** (`resolvePushHandler`): chat payloads
  (`conversation_id`/`message_id`/`content`), returns (`return_sn`), IN_CANCEL
  (`status`/cancel reason), tracking (`logistics_status`/`tracking_number`) and
  order status (`status`), so both the project matrix and real Shopee pushes are
  handled, and shop/item/promotion pushes never create spurious tickets. The pure
  `triageShopeePush` matrix from the contract is preserved and unit-tested.
- `eventId` for webhook idempotency follows the project contract
  (`message_id` | `code:ordersn` | `code:return_sn`), while hydrated system
  message ids are additionally suffixed with the official status timestamp so
  multiple status updates for the same order are not collapsed.
