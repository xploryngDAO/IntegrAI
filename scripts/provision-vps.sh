#!/usr/bin/env bash
# =============================================================================
# IntegrAI — provisionamento de VPS (Ubuntu/Debian) para o stack de produção
# =============================================================================
# Uso (como root, com o DNS já apontando para o IP):
#
#   DOMAIN=api.suaempresa.com \
#   WEB_ORIGIN=https://integrai-dev.vercel.app \
#   S3_ENDPOINT=https://... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
#   S3_BUCKET=sac-hub-raw S3_ATTACHMENTS_BUCKET=sac-hub-attachments \
#   bash scripts/provision-vps.sh
#
# O que faz:
#   1. instala Docker, git, ufw, fail2ban, curl, openssl;
#   2. clona/atualiza o repositório em /opt/integrai;
#   3. gera .env.prod com segredos (JWT, chave de cifra, senha do Postgres);
#   4. constrói as imagens da API e da SPA e sobe Postgres + Redis + API + web
#      + Caddy com TLS automático (Let's Encrypt);
#   5. libera somente 22/80/443 no firewall e valida /health/ready.
#
# Requisitos: DNS A/AAAA de $DOMAIN já apontando para este VPS; credenciais S3
# (AWS/R2/MinIO) no ambiente. NÃO armazena segredos no repositório.
# Idempotente: rode de novo para atualizar (git pull + rebuild) sem apagar dados.
# =============================================================================

set -euo pipefail

DOMAIN="${DOMAIN:-}"
WEB_ORIGIN="${WEB_ORIGIN:-https://integrai-dev.vercel.app}"
INSTALL_DIR="${INSTALL_DIR:-/opt/integrai}"
REPO_URL="${REPO_URL:-https://github.com/xploryngDAO/IntegrAI.git}"
BRANCH="${BRANCH:-main}"

die() { echo "[erro] $*" >&2; exit 1; }
log() { echo -e "\n==> $*"; }

[ "$(id -u)" -eq 0 ] || die "execute como root (sudo -i)"
[ -n "$DOMAIN" ] || die "defina DOMAIN (ex.: DOMAIN=api.suaempresa.com)"
for v in S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || die "defina $v no ambiente (storage S3 externo é obrigatório)"
done

if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
  public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$resolved" ] || die "DNS de $DOMAIN ainda não resolve; crie o A/AAAA e aguarde (ou use SKIP_DNS_CHECK=1)"
  if [ -n "$public_ip" ] && [ "$resolved" != "$public_ip" ]; then
    die "DNS de $DOMAIN resolve para $resolved, mas o IP público deste host é $public_ip. Corrija o DNS antes do Caddy (ou use SKIP_DNS_CHECK=1)."
  fi
  echo "[ok] DNS de $DOMAIN aponta para $resolved"
fi

export DEBIAN_FRONTEND=noninteractive
log "Instalando dependências do sistema"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw fail2ban openssl >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-v2 >/dev/null

log "Firewall (22/80/443) e fail2ban"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null || true

log "Repositório em $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only --quiet origin "$BRANCH"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

ENV_FILE="$INSTALL_DIR/.env.prod"
if [ ! -f "$ENV_FILE" ]; then
  log "Gerando $ENV_FILE (segredos aleatórios, permissão 600)"
  umask 077
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  JWT_SECRET="$(openssl rand -hex 32)"
  ENCRYPTION_MASTER_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  cat > "$ENV_FILE" <<EOF
# Gerado por scripts/provision-vps.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)
NODE_ENV=production
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_HOST_PORT=56380
POSTGRES_HOST_PORT=55433
API_HOST_PORT=4105
WEB_HOST_PORT=8080
DOMAIN=$DOMAIN
APP_BASE_URL=https://$DOMAIN
WEB_ORIGIN=$WEB_ORIGIN
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=1h
ENCRYPTION_MASTER_KEY=$ENCRYPTION_MASTER_KEY
ENCRYPTION_KEY_ID=prod-v1
RATE_LIMIT_GLOBAL_PER_MINUTE=1800
# Se a API estiver atrás do Caddy, confie apenas na rede interna:
TRUST_PROXY=172.16.0.0/12
S3_ENDPOINT=$S3_ENDPOINT
S3_REGION=${S3_REGION:-us-east-1}
S3_BUCKET=${S3_BUCKET:-sac-hub-raw}
S3_ATTACHMENTS_BUCKET=${S3_ATTACHMENTS_BUCKET:-sac-hub-attachments}
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-false}
EOF
  chmod 600 "$ENV_FILE"
  echo "[ok] Segredos gerados (não exibidos). Revise SMTP/S3 quando necessário."
else
  echo "[ok] Mantendo $ENV_FILE existente (revise DOMAIN/WEB_ORIGIN)"
fi

log "Construindo imagens (API + SPA)"
GIT_SHA="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
docker build -q -f packages/server/Dockerfile --build-arg GIT_SHA="$GIT_SHA" -t sac-hub-api:prod .
VITE_API_BASE_URL="https://$DOMAIN/api/v1" VITE_WS_URL="https://$DOMAIN" \
  docker build -q -f apps/web/Dockerfile -t sac-hub-web:prod .

log "Subindo o stack com TLS (Caddy)"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml --profile tls up -d

log "Aguardando /health/ready"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/v1/health/ready" >/dev/null 2>&1; then
    echo "[ok] API pronta em https://$DOMAIN"
    break
  fi
  sleep 3
  if [ "$i" -eq 60 ]; then
    die "API não respondeu em 3 min. Veja: docker compose -f docker-compose.prod.yml logs api"
  fi
done

cat <<EOF

==============================================================================
Provisionamento concluído.

Próximos passos:
1. Aponte apps/web/runtime-config.json para https://$DOMAIN/api/v1
   (e faça commit) OU use a tela de diagnósticos para salvar o endpoint.
2. WEB_ORIGIN atual no .env.prod: $WEB_ORIGIN
3. Crie o primeiro ADMIN pelo signup da SPA (e-mail verificado).
4. Valide: node scripts/verify-live.mjs https://$DOMAIN ...
5. Backups: docker compose -f docker-compose.prod.yml exec -T postgres pg_dump ...
==============================================================================
EOF
