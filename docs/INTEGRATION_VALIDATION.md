# Validação das integrações — o que foi provado e como provar o resto

O sistema **não simula** nenhuma integração. O que existe são quatro níveis de
evidência; os níveis 1–2 rodam sem credenciais, os níveis 3–4 exigem os acessos
reais e são executados por você no ambiente.

| Nível | O que prova | Como rodar | Requer credencial? |
|---|---|---|---|
| **L1 — Unitário** | algoritmos puros: assinatura Shopee, política de links, parsing MIME/Amazon, roteamento de claims, mapeamento de diagnose | `npm test` | não |
| **L2 — Conformidade com docs** | paths, verbos, headers, versões e parâmetros conferidos na documentação oficial de cada canal | revisão registrada abaixo | não |
| **L3 — Sonda ao vivo** | token exchange + leitura autenticada real em cada loja conectada | `npm run doctor` | **sim** |
| **L4 — Ponta a ponta** | webhook real → ticket na fila → resposta real no marketplace | jornada da seção 5 do `SETUP_PRODUCTION.md` | **sim** |

## L1 — executado neste repositório

```
vitest run → 11 arquivos / 92 testes verdes, incluindo:
  shopee/__tests__/sign.test.ts      HMAC-SHA256(partner_id+path+ts+token+shop_id)
  shopee/__tests__/triage.test.ts    triagem N1/N2, CRR
  meli/__tests__/claims.test.ts      available_actions / due_date
  meli/__tests__/routing.test.ts     rota A/B/C (questions, claims, pack)
  amazon/__tests__/orderId.test.ts   regex 3-7-7 e threading
  amazon/__tests__/policy.test.ts    bloqueio de link externo/e-mail
  amazon/__tests__/sesRelay.test.ts  MIME → mensagem normalizada
```

## L2 — conformidade com a documentação oficial

Verificado por leitura das docs oficiais (2026) e por revisão dos adapters:

**Amazon SP-API**
- LWA: `POST https://api.amazon.com/auth/o2/token`, form-urlencoded
  (`grant_type=refresh_token`), headers `x-amz-access-token` nas chamadas.
- Orders: `GET /orders/v0/orders/{orderId}` (dados do pedido sem RDT).
- RDT: `POST /tokens/2021-03-01/restrictedDataToken` com
  `dataElements: ["buyerInfo","shippingAddress"]`; token usado só na leitura
  restrita do pedido.
- Mensageria: `GET /messaging/v1/orders/{orderId}/messagingActions`,
  `POST /messaging/v1/orders/{orderId}/messages/{actionName}`.
- Anexos: `POST /uploads/2020-11-01/uploadDestinations/messaging` +
  `Content-MD5` + `PUT` binário na URL pré-assinada.
- Proativo x receptivo: SMTP relay apenas para resposta a `INBOUND_BUYER`;
  contato ativo só via SP-API com ação permitida (regra do blueprint).
- Registro do app: [SP-API Registration](https://developer-docs.amazon.com/sp-api/docs/sp-api-registration-overview)
  (private seller app, self-authorized).

**Mercado Livre**
- OAuth: `POST /oauth/token` (refresh rotativo, renovado sob Redlock).
- Perguntas: `GET /questions/{id}` + `POST /answers` `{question_id,text}`.
- Pós-venda: `GET/POST /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale`;
  anexos `POST /messages/attachments?tag=post_sale&site_id=MLB`.
- Claims: `GET /post-purchase/v1/claims/{id}` (+ `/messages`),
  `POST /post-purchase/v1/claims/{id}/actions/send-message` com
  `receiver_role: complainant|mediator`; ações `allow-return`, `refund`,
  `open-dispute` validadas por `players[role=respondent].available_actions`.
- `action_guide`: `GET/POST /messages/action_guide/packs/{packId}`.
- Notificações: payload `{_id, resource, user_id, topic, actions, sent}`;
  topics `questions`, `messages` (resource = hash resolvido via
  `GET /messages/{resource}`), `post_purchase` (actions `claims`/`claims_actions`,
  resource com prefixo `/post-purchase`), `orders_v2`, `shipments`.
  Recuperação de perdidas: `GET /missed_feeds?app_id=...` (janela de 2 dias).
- Contrato de webhook: `HTTP 200 em < 500 ms` (o sistema responde antes de
  qualquer chamada externa).
  Fonte: [Notificações](https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes).

**Shopee Open Platform v2**
- Assinatura: `HMAC-SHA256(partner_id + api_path + timestamp + access_token + shop_id, partner_key)`
  em 100% das chamadas privadas; públicas omitem token/shop.
- Auth: `GET /api/v2/shop/auth_partner` (assinado), `POST /api/v2/auth/token/get`.
- Chat: `/api/v2/sellerchat/send_message`, `upload_image`, `read_conversation`;
  CRR protegido com `read_conversation` após cada envio.
- Pós-venda: `/api/v2/returns/confirm|dispute|get_return_detail`,
  `/api/v2/order/handle_buyer_cancellation`.
- Dados: `/api/v2/order/get_order_detail`,
  `/api/v2/logistics/get_tracking_info`, `/api/v2/product/get_item_base_info`,
  `/api/v2/shop/get_shop_info`.
- Push perdido: `v2.push.get_lost_push_message` (cron de 5 min).
- Relógio: tolerância de 300 s no webhook; NTP obrigatório.

> Divergências encontradas nessa revisão foram corrigidas nos adapters
> (ver commits e relatórios das tasks 12–14). Em especial: resolução de
> `messages` do Meli por hash, prefixo `/post-purchase` nas claims e inclusão de
> recuperação via `missed_feeds`.

## L3 — sonda ao vivo (`npm run doctor`)

O comando usa **as credenciais reais já gravadas** e faz apenas leituras baratas:

| Canal | Checks | Chamada real |
|---|---|---|
| Amazon | `amazon.config`, `amazon.lwa`, `amazon.participations` (+`amazon.rdt`) | LWA token exchange + `GET /sellers/v1/marketplaceParticipations` (+ RDT quando `AMAZON_DIAGNOSE_ORDER_ID`) |
| Mercado Livre | `meli.config`, `meli.token`, `meli.identity` (+`meli.items`) | refresh/token + `GET /users/me` + `GET /users/{id}` |
| Shopee | `shopee.config`, `shopee.clock`, `shopee.sign`, `shopee.token`, `shopee.shop_info` (+`shopee.lost_push`) | `POST /api/v2/shop/get_shop_info` assinado (+ lost push) |
| Infra | `infra.postgres`, `infra.redis`, `infra.storage` | `SELECT 1`, `PING`, `HeadBucket` |

Cada check retorna `ok | warn | fail | skipped`, latência, detalhe e
`remediation` (o que corrigir). O comando sai com código 1 se houver `fail`, o
que permite usá-lo em monitoração.

```bash
npm run doctor                      # tudo
npm run doctor -- --account=<uuid>  # uma loja
```

Exemplo de saída sem credenciais (estado esperado antes de configurar):

```
SAC Hub diagnostics
───────────────────────────────────────────────
infra.postgres        ok    4ms   ok
infra.redis           ok    2ms   ok
infra.storage         warn  8ms   bucket não configurado (S3_ENDPOINT/S3_ACCESS_KEY_ID)
AMAZON  (sem lojas)   —
MELI    (sem lojas)   —
SHOPEE  (sem lojas)   —
Resultado: 1 warn · 0 fail
```

Depois de conectar as lojas, o esperado é **0 fail** em todos os checks.

## L4 — ponta a ponta (você executa)

1. Conecte uma loja real em `/accounts` (OAuth Shopee/Meli, refresh token Amazon).
2. `npm run doctor` → todos `ok`.
3. Gere um evento real (pergunta no Meli, mensagem no chat Shopee, e-mail ao
   endereço de relay Amazon).
4. Confirme o ticket na fila com SLA correto e o canal em `/channels/health`.
5. Responda pelo composer e confirme a entrega no marketplace (incluindo
   `read_conversation` no Shopee e a rota escolhida no Meli/Amazon).

## Limitações honestas

- **Não há credenciais reais neste ambiente**: nenhuma chamada autenticada aos
  marketplaces foi executada aqui. O que foi provado é o contrato (L1/L2) e o
  caminho de execução (L3) — a validação final é a sua, com suas credenciais.
- **Amazon** não oferece sandbox de Orders/Messaging; a homologação é feita na
  própria conta de vendedor (com um pedido real de teste). A verificação de PII
  depende de DPP aprovado.
- **Meli** não tem sandbox para pós-venda; use *test users* do DevCenter para
  OAuth e valide claims/notificações em conta de teste.
- **Shopee** tem sandbox (`partner.test-stable.shopeemobile.com`) para OAuth e
  push; o conteúdo de pedidos é sintético do próprio sandbox.
- A **Vercel** hospeda apenas o SPA. O backend (workers/crons/Postgres/Redis)
  precisa de Docker/VM/container host.

## Divergências encontradas e corrigidas nesta rodada (L2 → código)

Revisão dos adapters contra os modelos/documentos oficiais (nov/2026). Cada item
foi corrigido no código e coberto por teste com transporte stubado.

**Amazon**
- getMessagingActionsForOrder estava com path inventado: o correto é
  GET /messaging/v1/orders/{amazonOrderId}?marketplaceIds=<site> e o retorno
  lê _links.actions[].name / _embedded.actions[].payload.name.
- Envio de mensagem: marketplaceIds é **query**; body varia por ação
  (warranty não aceita texto livre; confirmCustomizationDetails limita
  800 chars/5 anexos; confirmDeliveryDetails/unexpectedProblem 2000 chars);
  resposta 201 sem messageId (id externo determinístico).
- Uploads: contentMD5 é query e {resource} é o path completo da mensagem;
  payload.headers do destino agora acompanham o PUT pré-assinado.
- Roteamento proativo virou capability-aware, com novo motivo
  PROACTIVE_ACTION_UNSUPPORTED (sem perder NEED_PRIOR_INBOUND).

**Mercado Livre**
- Notificações messages: esource é um **hash opaco** resolvido com
  GET /messages/{resource}; claims vêm em 	opic: post_purchase com
  ctions: claims|claims_actions e resource com prefixo /post-purchase.
- ction_guide: GET com ?tag=post_sale; POST correto é
  /messages/action_guide/packs/{pack}/option?tag=post_sale com
  option_id/	emplate_id/	ext/ars.
- Pack messages: rom/	o (user ids) e ttachments como **array de strings**;
  hidratação usa mark_as_read=false e aceita conversation_status.claim_ids.
- Claims: anexo retorna {user_id, file_name} (não id); mensagens oficiais têm
  sender_role/message/date_created (sem id → chave de idempotência
  determinística); fallbacks post-purchase/v1 ↔ marketplace/v2.
- **Recuperação de notificações perdidas** implementada com
  GET /missed_feeds?app_id= (janela de 2 dias), cursor em Redis e republicação
  em queue.inbound.meli.

**Shopee**
- Refresh token oficial: POST /api/v2/auth/access_token/get (code exchange
  continua em /auth/token/get).
- GET com query correta: sellerchat/get_message, order/get_order_detail
  (order_sn_list + esponse_optional_fields), logistics/get_tracking_info,
  product/get_item_base_info (repetição de item_id_list), eturns/get_return_detail.
- Push perdido: GET /api/v2/push/get_lost_push_message é **público e sem
  parâmetros**; retorno push_message_list/last_message_id; confirmação em
  POST /api/v2/push/confirm_consumed_lost_push_message.
- eturns/dispute: novo contrato {return_sn, email, dispute_reason_id,
  image_list[{module_index, requirement, image_url[]}], dispute_text_reason};
  módulos de evidência vêm de eturns/get_return_dispute_reason.
- Divergência de push codes: a matriz do projeto (2/3/4/6/7/10) difere da matriz
  pública da Shopee; o hydrator passou a **despachar por formato do payload**
  primeiro, aceitando as duas matrizes sem criar tickets espúrios.

## O que ainda é humano (e por quê)

Criar os apps nos portais, gerar refresh token/partner keys, aprovar roles/DPP,
configurar callback URLs e rodar 
pm run doctor **com credenciais reais**.
Sem esses acessos, nenhuma chamada autenticada pode ser executada por mim — foi
exatamente o que fiz ser detectável e remediável pelo diagnóstico.
