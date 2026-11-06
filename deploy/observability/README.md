# Observabilidade — Prometheus + Grafana

Artefatos para monitorar o stack self-hosted usando o endpoint `/api/v1/metrics`.

## Arquivos

- `prometheus.yml` — scrape da API (`Bearer METRICS_TOKEN`) e do Caddy.
- `alerts.yml` — regras: API/db/redis/storage down, 5xx > 2%, p95 > 1s, sem tráfego.

## Como usar

1. Defina `METRICS_TOKEN` no `.env.prod` e reinicie a API.
2. Coloque o token em um arquivo somente leitura (`METRICS_TOKEN`) montado no
   Prometheus em `/etc/prometheus/METRICS_TOKEN`.
3. Suba o Prometheus apontando para os arquivos:

```yaml
prometheus:
  image: prom/prometheus:v3.1.0
  volumes:
    - ./deploy/observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    - ./deploy/observability/alerts.yml:/etc/prometheus/alerts.yml:ro
    - ./METRICS_TOKEN:/etc/prometheus/METRICS_TOKEN:ro
  ports: ['9090:9090']
```

4. Grafana (opcional): datasource Prometheus `http://prometheus:9090` e painéis:
   - `sum(rate(sac_http_requests_total[5m]))` — RPS
   - `sum(rate(sac_http_requests_total{status_class="5xx"}[5m]))` — erros
   - `histogram_quantile(0.95, sum by (le)(rate(sac_http_request_duration_seconds_bucket[5m])))` — p95
   - `sac_db_up`, `sac_redis_up`, `sac_storage_up`, `sac_process_uptime_seconds`

## Validação

```bash
docker run --rm -v "$PWD/deploy/observability/alerts.yml:/alerts.yml" \
  --entrypoint promtool prom/prometheus:v3.1.0 check rules /alerts.yml
```

> O endpoint `/metrics` é protegido por token; sem `METRICS_TOKEN` configurado ele responde 404
> (desabilitado por padrão).
