# Links rápidos — SAC Hub

> Atualizado em 2026-11-05. O túnel da API é temporário e muda se o processo for
> reiniciado (ver [DEPLOY_LOCAL_TUNNEL](DEPLOY_LOCAL_TUNNEL.md)).

## 1. Acessar o sistema agora

| O quê | Link |
|---|---|
| Aplicação (SPA na Vercel) | <https://integrai-dev.vercel.app> |
| API — health público | <https://growth-voters-independent-rca.trycloudflare.com/api/v1/health> |
| API — diagnóstico (ADMIN, precisa de JWT) | `GET …/api/v1/diagnostics` |
| Console do projeto na Vercel | <https://vercel.com/xploryngdaos-projects/integrai-dev> |
| Variáveis da Vercel | <https://vercel.com/xploryngdaos-projects/integrai-dev/settings/environment-variables> |
| Deployments da Vercel | <https://vercel.com/xploryngdaos-projects/integrai-dev/deployments> |
| Repositório no GitHub | <https://github.com/xploryngDAO/IntegrAI> |
| Ações (CI/deploy) do GitHub | <https://github.com/xploryngDAO/IntegrAI/actions> |

Login do operador criado no bootstrap: `admin@integr-ai.local` (senha em `.env`,
não versionada).

## 2. Portais dos marketplaces

### Amazon (SP-API)
| O quê | Link |
|---|---|
| Seller Central (Brasil) | <https://sellercentral.amazon.com.br/> |
| Seller Central — Apps and Services | <https://sellercentral.amazon.com.br/apps-and-services/> |
| Registrar como desenvolvedor (visão geral) | <https://developer-docs.amazon.com/sp-api/docs/sp-api-registration-overview> |
| Registrar **private developer** (self-authorized) | <https://developer-docs.amazon.com/sp-api/docs/register-as-a-private-developer> |
| Roles necessárias | <https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api> |
| Mensageria (envio de mensagens) | <https://developer-docs.amazon.com/sp-api/docs/messaging-api> |
| RDT (dados restritos / PII) | <https://developer-docs.amazon.com/sp-api/docs/tokens-api> |
| AWS SES — recebimento de e-mail (relay) | <https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html> |
| Buyer-Seller Messaging (relay SMTP) | <https://sellercentral.amazon.com.br/messaging/> |

### Mercado Livre
| O quê | Link |
|---|---|
| DevCenter — criar/gerenciar aplicação | <https://developers.mercadolivre.com.br/devcenter> |
| Como criar a aplicação | <https://developers.mercadolivre.com.br/pt_br/crie-uma-aplicacao-no-mercado-livre> |
| Autenticação e autorização (OAuth) | <https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao> |
| Notificações (webhooks/tópicos) | <https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes> |
| Reclamações (claims) | <https://developers.mercadolivre.com.br/pt_br/gerenciar-reclamacoes> |
| Mensageria pós-venda | <https://developers.mercadolivre.com.br/pt_br/mensagens-post-venda> |

### Shopee
| O quê | Link |
|---|---|
| Open Platform (portal do parceiro) | <https://open.shopee.com/> |
| Console de apps | <https://open.shopee.com/console/app> |
| Developer guide (v2) | <https://open.shopee.com/developer-guide/4> |
| Documentação da API v2 | <https://open.shopee.com/documents/v2/v2.shop.get_shop_info> |
| Push / webhooks | <https://open.shopee.com/developer-guide/4#push> |

## 3. Hospedagem definitiva da API (opcional, mas recomendado)

O backend não roda na Vercel (workers + Postgres + Redis). Opções com Docker:

| Provedor | Link |
|---|---|
| Railway | <https://railway.app/new> |
| Render | <https://dashboard.render.com/select-repo> |
| Fly.io | <https://fly.io/dashboard> |
| Cloudflare Tunnel (URL permanente, com conta) | <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/> |
| AWS (ECS/S3 + SES + RDS/ElastiCache) | <https://console.aws.amazon.com/> |

## 4. Documentação do próprio projeto

- [SETUP_PRODUCTION.md](SETUP_PRODUCTION.md) — passo a passo de cada canal até o go-live
- [INTEGRATION_VALIDATION.md](INTEGRATION_VALIDATION.md) — o que foi validado e como validar
- [DEPLOY_LOCAL_TUNNEL.md](DEPLOY_LOCAL_TUNNEL.md) — como este deploy atual está montado
- [API_CONTRACT.md](API_CONTRACT.md) — todos os endpoints
- [CHANNEL_CONTRACTS.md](CHANNEL_CONTRACTS.md) — regras por canal
- [ARCHITECTURE.md](ARCHITECTURE.md) — desenho do sistema
