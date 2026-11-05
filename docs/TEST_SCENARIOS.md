# Cenários de validação — SAC Hub (canal Mercado Livre real)

> Estado em 05/11/2026: conta **Mercado Livre conectada** (seller `3816933555`,
> nickname `MF20261105151338980`, site MLB, status active). Token Bearer válido,
> refresh token cifrado no banco. A loja ainda **não tem anúncios** (`items=0`),
> então perguntas/pedidos reais só passam a existir depois da primeira publicação.

## 1. Automatizados (executados agora)

Rode a qualquer momento:

```bash
node scripts/validate-live.mjs
# ou: npm run validate:live
```

Resultado da última execução (11/11):

| # | Cenário | Evidência |
|---|---|---|
| A1 | Health público + Postgres/Redis ok | `200`, `db=true`, `redis=true` |
| A2 | Login do ADMIN retorna JWT | `200` |
| A3 | Conta Meli conectada listada | `Mercado Livre · Loja Principal (ACTIVE)` |
| A4 | Diagnóstico real do canal sem `fail` | 4 checks: `config`, `token`, `identity` ok; `items` warn (loja sem anúncios) |
| A5 | Diagnóstico global sem `fail` de infra | `overall=warn`, 0 fail de infraestrutura |
| A6 | Webhook Meli responde `200` em <500 ms | `41 ms` |
| A7 | Reentrega idêntica responde `200` | `45 ms` |
| A8 | Evento inválido não cria ticket fantasma | `total=0` |
| C1 | `GET /tickets` sem token | `401` |
| C2 | Webhook Shopee sem assinatura | `401` |
| C3 | Webhook Amazon SES sem assinatura | `401` |

## 2. Roteiro manual na interface (você valida)

Acesse **https://integrai-dev.vercel.app** com `admin@integr-ai.local` / senha do `.env`.

| # | Passo | Resultado esperado |
|---|---|---|
| D1 | Login com credencial errada | mensagem real de credenciais inválidas, sem entrar |
| D2 | Login correto | workspace abre com fila vazia (`0 abertos`), sem banner de demonstração |
| D3 | Topbar | lojas conectadas refletem o banco (`1 loja`), health do canal real |
| D4 | `/accounts` → cartão Mercado Livre | pílula **Conectado**, opções de credencial/refresh/desconectar |
| D5 | **Testar conexão** no cartão Meli | checks reais: `meli.config`, `meli.token`, `meli.identity` ok; `meli.items` warn (sem anúncios) |
| D6 | **Diagnosticar canais** no cabeçalho | diálogo com infraestrutura (Postgres/Redis/S3) e seção Canais |
| D7 | Tema claro/escuro no ícone da lua | alterna e persiste após recarregar |
| D8 | Redimensionar para ~390 px | colunas colapsam sem overflow horizontal |
| D9 | Logout | volta ao login; `GET /tickets` sem token continua `401` |
| D10 | Acessar `/accounts` sem sessão | redireciona para o login |

## 3. Cenários que exigem evento real do marketplace

Nada disso é simulado — depende de atividade real na loja:

| # | Como gerar | O que validar |
|---|---|---|
| E1 | Publicar 1 anúncio e fazer uma **pergunta** com outra conta | webhook `questions` → ticket `PRÉ-VENDA` na fila, thread com a pergunta, resposta enviada pelo composer |
| E2 | Vender o anúncio (ou usar test user do Meli) | webhook `orders_v2` → ticket `PÓS-VENDA`, pedido no cockpit 360°, SLA calculado |
| E3 | Abrir uma **reclamação** no pedido | webhook `post_purchase`/`claims` → ticket `CLAIM`, ações disponíveis (responder, reembolsar, etc.) |
| E4 | Enviar mensagem pós-venda pelo painel do Meli | webhook `messages` → mensagem na thread (hash resolvido via `GET /messages/{resource}`) |
| E5 | Deixar o webhook indisponível e reativar | `runMaintenance` recupera via `GET /missed_feeds` (cursor no Redis, sem duplicar) |

Para conferir a ingestão em cada caso:

```bash
docker exec sac-postgres psql -U sac -d sac_hub -c \
  "select id, marketplace, topic, status, received_at from webhook_events order by received_at desc limit 5;"

docker exec sac-postgres psql -U sac -d sac_hub -c \
  "select protocol, ticket_type, status, marketplace, last_inbound_at from support_tickets order by created_at desc limit 5;"
```

## 4. Dataset temporário para validar chat/cockpit/SLA (opcional)

Como a loja ainda não tem anúncios/pedidos, a fila fica vazia. Se quiser validar
a UI de conversa **antes** do primeiro evento real, posso criar um comando
`npm run db:seed:validation` que insere conversas marcadas com prefixo `TESTE-`
(pergunta, pós-venda e claim) e `npm run db:seed:validation:clear` para remover.
Ele **não** roda no bootstrap nem em produção e não altera o seed normal — é
ferramenta de teste. Peça que eu implemente/execute.

## 5. Limpeza

- Desconectar a loja: `/accounts` → cartão Meli → desconectar (remove token cifrado).
- Remover eventos de teste: `delete from webhook_events where id like 'validation-%';`
- Reverter o probe de itens: remover `MELI_DIAGNOSE_PROBE` do `.env` e reiniciar a API.
