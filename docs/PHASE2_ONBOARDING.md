# Fase 2 — Onboarding guiado e Amazon via OAuth

> Objetivo: cliente novo conecta Meli/Shopee em <3 min e Amazon via autorização
> OAuth (sem colar credenciais LWA). O wizard usa o diagnóstico real como
> critério de conclusão.

## 1. Fluxo do wizard (`/onboarding`)

1. **Boas-vindas** — nome da empresa/tenant, 3 passos, opção “pular por agora”.
2. **Conectar lojas** — cartões por canal com estado (não conectado, conectado, atenção).
   - Meli/Shopee: botão OAuth existente (`POST /accounts/oauth/:mp/start`).
   - Amazon: botão “Autorizar na Amazon” (novo fluxo OAuth — ver §2).
3. **Diagnóstico** — após conectar, `POST /accounts/:id/diagnose`; mostra checks
   `ok/warn/fail/skipped` com latência e remediação.
4. **Primeiro atendimento** — explica que a fila enche quando o primeiro evento
   real chegar; link para `/` e para o guia de teste (`/docs/TEST_SCENARIOS`).
5. **Concluir** — marca `onboarding_completed_at` no tenant; dashboard não bloqueia.

Comportamento:
- Sempre reexecutável em `/accounts` → “Reconectar/Testar”.
- Estado do wizard derivado de dados reais (contas + diagnóstico), sem flag falsa.
- Mobile-first, tema claro/escuro, DS Convergência.

## 2. Amazon OAuth (SP-API) — design

Hoje a UI pede LWA client id/secret + refresh token. Para cliente final, trocar por:

1. `POST /api/v1/accounts/oauth/amazon/start`:
   - assina `state` (igual Meli/Shopee, incluindo `tenantId`);
   - monta `https://sellercentral.amazon.com/apps/authorize/consent?application_id=<APP_ID>&state=<state>&version=beta`;
   - devolve `authorizeUrl`.
2. Cliente autoriza no Seller Central; Amazon redireciona para
   `GET /api/v1/accounts/oauth/amazon/callback?state=&selling_partner_id=&spapi_oauth_code=`.
3. Callback:
   - valida state;
   - `POST https://api.amazon.com/auth/o2/token` com `grant_type=authorization_code`,
     `code`, `client_id`, `client_secret`, `redirect_uri`;
   - descobre `selling_partner_id`, cria conta com `tenantId`, tokens cifrados;
   - redireciona para `/accounts?connected=amazon`.
4. Diagnóstico: LWA + marketplaceParticipations; RDT só com `AMAZON_DIAGNOSE_ORDER_ID`.
5. Pré-requisitos externos: app público SP-API aprovado, DPP aceito, security
   assessment (Fase 3) e `AMAZON_APP_ID`/redirect registrados na Amazon.

Variáveis novas: `AMAZON_APP_ID`, `AMAZON_APP_REDIRECT_URI`, `AMAZON_OAUTH_AUTHORIZE_URL`
(default `https://sellercentral.amazon.com/apps/authorize/consent`).

## 3. Endpoints novos/alterados

| Método | Rota | Mudança |
|---|---|---|
| GET | `/onboarding` (SPA) | wizard |
| POST | `/accounts/oauth/amazon/start` | novo |
| GET | `/accounts/oauth/amazon/callback` | novo (allowlist pública) |
| POST | `/accounts/connect` | mantido para backward-compat (LWA manual) |
| PATCH | `/tenants/me` | salvar `onboarding_completed_at` |

## 4. Critérios de aceite

- Cliente novo: signup → verificar e-mail → onboarding → autorizar Meli → diagnóstico ok.
- Nenhum campo técnico visível para Meli/Shopee/Amazon.
- Amazon OAuth só habilitado quando `AMAZON_APP_ID` configurado; caso contrário,
  card mostra “indisponível” com remediação (sem formulário técnico).
- Wizard não bloqueia o workspace e pode ser refeito.

## 5. Riscos

- Amazon exige app público aprovado para multi-seller (Fase 3) — sem isso, o OAuth
  do seller não funciona em produção.
- URL de consentimento varia por região (NA/EU/FE); parametrizar por ambiente.
- SES inbound/relay continua sendo configuração operacional guiada, não do cliente.
