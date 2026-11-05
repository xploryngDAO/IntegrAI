# Fase 3 — Submissão dos apps de marketplace

> Objetivo: a IntegrAI opera **um app por marketplace** e cada cliente apenas
> autoriza a própria loja. Estes são os artefatos e passos externos (aprovações)
> necessários para produção multi-cliente.

## 1. Mercado Livre

| Item | Detalhe |
|---|---|
| App | DevCenter → aplicação **SAC Hub IntegrAI** (Client ID/Secret já criados) |
| Redirect | `https://<api>/api/v1/accounts/oauth/mercadolivre/callback` |
| Webhook | `https://<api>/webhooks/mercadolivre` |
| Tópicos | `orders_v2`, `messages`, `questions`, `shipments`, `post_purchase` |
| Escopos | Usuários, Comunicações e Venda/envios **leitura e escrita**; demais leitura |
| Certificação | Opcional para operar; obrigatória para selo/limites maiores (`Developer Partner Program`) |
| Checklist | app preenchido, logo, descrição, domínio de privacidade, termos, suporte, e-mail de contato |

Passos:
1. Revisar dados da aplicação e domínio público.
2. Publicar página de privacidade/termos (obrigatório no diretório).
3. Solicitar certificação no Developer Partner Program quando o volume exigir.
4. Validar `GET /missed_feeds` e a rotação de refresh em produção.

## 2. Shopee

| Item | Detalhe |
|---|---|
| App | Open Platform → app **SAC Hub IntegrAI** (partner_id/key) |
| Redirect | `https://<api>/api/v1/accounts/oauth/shopee/callback` |
| Push | `https://<api>/webhooks/shopee` (HMAC `url|rawBody`) |
| Sandbox | `https://openplatform.sandbox.test-stable.shopee.sg` (ou host BR de sandbox) |
| Produção BR | `https://openplatform.shopee.com.br` |
| Checklist | app aprovado, push URL HTTPS, permissões de chat/orders/returns/logistics, logo, contato |

Passos:
1. Criar app no console, preencher dados da empresa.
2. Configurar push URL e testar com o sandbox (`SHOPEE_API_BASE`).
3. Solicitar aprovação das permissões (chat, pedidos, logística, devoluções).
4. Publicar em produção e validar `get_shop_info`, `get_message`, `get_order_detail`, `returns`.

## 3. Amazon (SP-API)

| Item | Detalhe |
|---|---|
| Tipo | **App público** (multi-seller) — app privado exigiria credenciais por cliente |
| Registro | Seller Central → Developer Central → criar app SP-API |
| LWA | Client ID/Secret do app IntegrAI (não do cliente) |
| Autorização | cliente autoriza o app no Seller Central (`/apps/authorize`) |
| Roles | Product Listing, Orders, Buyer Communication, Direct-to-Consumer Shipping |
| DPP | Data Protection Policy — obrigatório para PII (RDT) |
| Segurança | Security assessment da Amazon (pentest/questionário) antes de produção |
| Webhooks | SES inbound → `https://<api>/webhooks/amazon/ses` assinado |
| E-mail | relay SMTP aprovado no Seller Central (Buyer-Seller Messaging) |

Passos:
1. Criar app público e preencher casos de uso (mensageria, pedidos, pós-venda).
2. Submeter **security assessment** (documentação de arquitetura, criptografia, retenção de PII).
3. Aceitar DPP e configurar RDT.
4. Implementar fluxo de autorização OAuth do seller (substituir formulário LWA da UI).
5. Homologar em conta de teste e publicar.

## 4. Artefatos a manter no repositório

- `docs/PRIVACY.md` e `docs/TERMS.md` (páginas públicas)
- Política de retenção/expurgo de PII (já implementada: vault 30 dias)
- Descrição de arquitetura de segurança (criptografia de tokens, isolamento por tenant)
- Screenshots do produto para os diretórios (Meli/Shopee)
- Checklist de go-live em `docs/SETUP_PRODUCTION.md`

## 5. Riscos e prazos

| Risco | Mitigação |
|---|---|
| Reprovação no security assessment da Amazon | revisar criptografia, logs sem PII, escopos mínimos, RDT |
| Aprovação Shopee demorada | iniciar cedo, usar sandbox enquanto aguarda |
| Certificação Meli exigida por volume | solicitar antes de escalar clientes |
| Mudança de contrato de API | conformance já documentada em `docs/INTEGRATION_VALIDATION.md` |
