# Baseline de performance (2026-11-06)

Medição local para detectar regressões e dimensionar o host. **Não substitui** um teste de
carga no ambiente definitivo (rede, TLS, proxy e disco reais).

## Metodologia

- API de desenvolvimento (`node packages/server/dist/index.js`) no mesmo host
- PostgreSQL 16 e Redis 7 em Docker local
- Ferramenta: [`autocannon`](https://github.com/mcollina/autocannon) via `npx`
- 10 conexões, 10 segundos, keep-alive (`-p 2`); endpoints isentos de rate limit
- Endpoints autenticados não foram incluídos para não consumir os buckets de login
  (`600 req/min` global; login em bucket próprio)

```bash
npx --yes autocannon -c 10 -d 10 -p 2 http://127.0.0.1:4101/api/v1/health
npx --yes autocannon -c 10 -d 10 -p 2 http://127.0.0.1:4101/api/v1/status
```

## Resultados (CPU compartilhada, logging de desenvolvimento)

| Endpoint | Carga | RPS médio | RPS p97.5 | Observação |
|---|---|---|---|---|
| `GET /api/v1/health` | 10 conexões | **232,9** | 300 | liveness da API (sem I/O) |
| `GET /api/v1/status` | 10 conexões | **192,4** | 241 | readiness de DB/Redis/S3 + canais |

- ~2 mil requisições por teste, 0 erros/timeouts
- `health` ≈ 4,3 ms/req médio; `status` ≈ 5,2 ms/req médio na carga
- Ambos os endpoints são usados por load balancer/monitoramento; o gargalo real do
  produto está nas rotas autenticadas com DB + fila (medir no host final).

## Limitações

- Notebook compartilhado (Docker Desktop no Windows), não um servidor dedicado
- Sem TLS/proxy na frente (Caddy/nginx adicionam latência e terminam HTTP/2)
- Um único processo Node (sem `cluster`/réplicas)
- Teste de curta duração; não captura vazamento de memória ou contenção sob picos

## Recomendação para o host definitivo

1. Rodar o mesmo teste na VM/instância de produção com `autocannon` ou `k6` (rampa até ~10x
   a carga esperada; mix de rotas autenticadas com token válido, respeitando os buckets).
2. Metas sugeridas: p95 < 300 ms para `GET` de fila/tickets; erro < 0,1%; CPU < 70% no pico.
3. Se necessário, subir a API com réplicas atrás do nginx/Caddy (stateless: JWT + Redis + PG) e
   monitorar via Prometheus (`sac_http_request_duration_seconds`).
