#!/usr/bin/env bash
# =============================================================================
# IntegrAI — restauração do PostgreSQL a partir de um backup do provisionamento
# =============================================================================
# Uso (no VPS, como root):
#   CONFIRM=yes bash scripts/restore-postgres.sh                 # backup mais recente
#   CONFIRM=yes bash scripts/restore-postgres.sh /var/backups/integrai/db-....sql.gz
#
# O script:
#   1. exige CONFIRM=yes (operação destrutiva);
#   2. gera um backup de segurança ANTES de restaurar (se possível);
#   3. para API/web para evitar escritas durante o restore;
#   4. restaura o dump com `psql -v ON_ERROR_STOP=1`;
#   5. sobe a API de volta e valida /health/ready.
#
# O dump gerado por `scripts/provision-vps.sh` é plain SQL comprimido (gzip).
# =============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/integrai/.env.prod}"
INSTALL_DIR="${INSTALL_DIR:-/opt/integrai}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/integrai}"
DOMAIN="${DOMAIN:-}"

die() { echo "[erro] $*" >&2; exit 1; }
log() { echo -e "\n==> $*"; }

[ "$(id -u)" -eq 0 ] || die "execute como root (sudo -i)"
[ "${CONFIRM:-}" = "yes" ] || die "operação destrutiva: rode com CONFIRM=yes"
[ -f "$ENV_FILE" ] || die "não encontrei $ENV_FILE"
[ -d "$INSTALL_DIR/.git" ] || die "repositório ausente em $INSTALL_DIR"

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- || true)"
  [ -n "$FILE" ] || die "nenhum backup em $BACKUP_DIR"
fi
[ -f "$FILE" ] || die "arquivo não encontrado: $FILE"
gzip -t "$FILE" >/dev/null 2>&1 || die "backup corrompido (gzip -t falhou): $FILE"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2 || true)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2 || true)"
POSTGRES_USER="${POSTGRES_USER:-sac}"
POSTGRES_DB="${POSTGRES_DB:-sac_hub}"

cd "$INSTALL_DIR"

log "Backup de segurança antes do restore"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$BACKUP_DIR/db-pre-restore-$STAMP.sql.gz"

log "Parando API e web para evitar escritas"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml stop api web >/dev/null

log "Restaurando $FILE"
gunzip -c "$FILE" | docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml \
  exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

log "Subindo API e web"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml start api web >/dev/null

if [ -n "$DOMAIN" ]; then
  log "Aguardando /health/ready"
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/v1/health/ready" >/dev/null 2>&1; then
      echo "[ok] API pronta após o restore"
      exit 0
    fi
    sleep 3
  done
  die "restore concluído, mas /health/ready não respondeu; verifique os logs da API"
fi

echo "[ok] Restore concluído. Valide /health/ready e o login antes de liberar o acesso."
