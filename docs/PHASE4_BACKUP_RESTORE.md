# Fase 4 — Backup e restore por tenant

> Complemento de [PHASE4_PLATFORM](PHASE4_PLATFORM.md). As três rotas exigem JWT
> + `agents.is_platform_admin` (o mesmo `requirePlatformAdmin`, re-lido do banco
> a cada request): ADMIN de tenant recebe `403`.

O backup é um **artefato JSON versionado** de um workspace, persistido no bucket
bruto e indexado em `tenant_backups`. O artifacto nunca contém credenciais; o
restore sempre cria um **workspace NOVO**.

## Modelo de dados

```sql
tenant_backups
  id          UUID PK
  tenant_id   UUID FK tenants ON DELETE CASCADE
  s3_key      VARCHAR(512)     -- backups/<slug>/<timestamp>.json
  size_bytes  INT
  counts      JSONB            -- contagem por tabela
  created_by  UUID NULL        -- platform admin
  created_at  TIMESTAMPTZ

  UNIQUE (tenant_id, s3_key)
  INDEX  (tenant_id, created_at)

agents
  must_reset_password BOOLEAN NOT NULL DEFAULT false
```

Migração: `prisma/migrations/20251114000000_phase4_tenant_backups`.

`must_reset_password` marca o operador recriado por um restore (senha temporária
aleatória nunca divulgada); o próximo `reset-password` grava a senha e
`PrismaAgentRepository.updatePassword` zera o flag.

## `POST /platform/tenants/:id/backup`

Gera o arquivo completo do tenant, grava em
`backups/<tenantSlug>/<timestamp>.json` via `IObjectStorage.putObject`
(`contentType: application/json`) e **só então** insere a linha de índice. A
resposta não devolve o conteúdo, apenas o ponteiro:

```json
{
  "backupKey": "backups/acme/2026-11-05T12-00-00-000Z.json",
  "sizeBytes": 48213,
  "counts": {
    "agents": 5, "accounts": 3, "tickets": 40, "messages": 120,
    "attachments": 7, "events": 31, "outboundAttempts": 12,
    "orders": 22, "slaPolicies": 2, "webhookEvents": 90
  },
  "createdAt": "2026-11-05T12:00:00.000Z"
}
```

Metadados do objeto S3: `tenant-id`, `tenant-slug`, `backup-format` (`1.0`),
`created-by` e `counts` (JSON serializado).

O JSON tem `meta` (`kind: "tenant-backup"`, `formatVersion: "1.0"`, autor,
tenant de origem, `counts`, `notes`) e as tabelas `tenant`, `agents`,
`accounts`, `tickets`, `messages`, `attachments` (metadados), `events`,
`outboundAttempts`, `orders`, `slaPolicies` e `webhookEvents`.

**Excluído de propósito** (o `meta.notes` repete a lista no próprio arquivo):

- `agents.password_hash`, `two_factor_secret_enc` e códigos de recuperação;
- `marketplace_accounts.access_token_enc` / `refresh_token_enc`;
- `sessions`, `invitations`, `password_resets` e `email_verifications`
  (estado de autenticação nunca é copiado);
- `buyer_pii_vault` (dados restritos, expurgados pelo job de retenção);
- `webhook_events.payload`, `payload_s3_uri`, `resource` e `error` (dump bruto
  do marketplace, que pode conter PII);
- artefatos binários do S3: anexos entram somente como metadados;
- chaves de `channel_config` que pareçam credencial (`token`, `secret`,
  `password`, `api_key`, `private_key`), a mesma regra do export LGPD.

O backup lê **todas** as linhas do tenant (não é amostra como o export LGPD),
sem limite de paginação. Erros: `404` workspace desconhecido; falha do storage
`502 STORAGE_PUT_FAILED`.

## `GET /platform/tenants/:id/backups`

Lista o índice (mais recente primeiro). `IObjectStorage` não expõe ListObjects,
então a tabela é a fonte de verdade — o objeto sozinho não é descoberto por
listagem de bucket.

```json
{
  "data": [
    {
      "id": "uuid", "tenantId": "uuid",
      "backupKey": "backups/acme/2026-11-05T12-00-00-000Z.json",
      "sizeBytes": 48213,
      "counts": { "agents": 5, "accounts": 3, "tickets": 40, "messages": 120,
                  "attachments": 7, "events": 31, "outboundAttempts": 12,
                  "orders": 22, "slaPolicies": 2, "webhookEvents": 90 },
      "createdBy": "uuid-do-platform-admin",
      "createdAt": "2026-11-05T12:00:00.000Z"
    }
  ]
}
```

`404` workspace desconhecido; sem backups, `data: []`.

## `POST /platform/tenants/restore`

Body `.strict()`:

```json
{ "backupKey": "backups/acme/2026-11-05T12-00-00-000Z.json",
  "newSlug": "acme-restored", "newName": "Acme Restored" }
```

1. `backupKey` precisa casar `backups/<tenant>/<timestamp>.json` (nunca uma
   chave arbitrária do bucket).
2. `newSlug` é normalizado para minúsculas e validado (1..80, letras/números/
   hífen interno); `newName` 1..160.
3. Slug já usado → `409 CONFLICT` (`details.code = TENANT_SLUG_CONFLICT`). O
   restore **nunca sobrescreve** um workspace existente (nem soft-deleted).
4. Objeto ausente no S3 → `404 NOT_FOUND`; JSON inválido, `kind`/versão errados
   ou tabela ausente → `422 VALIDATION_ERROR`.
5. Cria um tenant NOVO (uuid novo, `status = ACTIVE`, `plan`/quotas do backup,
   `billing_status = TRIALING`, `deleted_at = null`).
6. Recria o grafo em **uma transação**, com ids novos e referências remapeadas:
   `agents` → `accounts` → `orders` → `tickets` → `sla_policies` → `messages` →
   `attachments` → `events` → `outbound_attempts` → `webhook_events`. As linhas
   apontam para o novo `tenant_id`.
7. Resposta mínima: `{ "tenantId": "...", "slug": "acme-restored", "counts":
   {...} }`. As senhas temporárias nunca são retornadas.

**Credenciais e estado de autenticação não são restaurados.** Cada loja volta
`DISCONNECTED`, sem tokens/expiração: reconecte Meli/Shopee/Amazon. Cada agente
é recriado com senha temporária aleatória (bcrypt), `must_reset_password =
true`, 2FA desligado (`two_factor_secret_enc = null`) e `is_platform_admin =
false` — um backup jamais re-concede o console de plataforma. O próximo
`reset-password` grava a senha e limpa o flag (`updatePassword` zera
`must_reset_password`); a entrega do link por e-mail é o fluxo existente da
Fase 1.

Chaves naturais **globais** que ainda existem no banco são desambiguadas para o
restore não falhar: e-mail de agente ganha `+restored-<slug>-<n>` no local part;
`external_seller_id` e `external_order_id` ganham sufixo `~r<tenant>-<n>`;
`external_message_id` e `webhook_events.event_id` são preservados apenas quando
livres (caso contrário ficam `null`, pois são chaves de idempotência do
workspace de origem). O `webhook_events` restaurado não carrega payload bruto
nem `resource`. O sufixo só aparece ao clonar um workspace cuja chave natural
ainda existe; ele deixa de casar com o registro original (é o preço de manter a
constraint global intacta).

O artefato restaurado também é indexado sob o **novo** tenant, então
`GET .../backups` mostra a origem.

## Decisões

1. **Tabela índice em vez de listagem do bucket.** `IObjectStorage` não tem
   `listObjects` (e ListObjects costuma ser negado em produção);
   `tenant_backups` guarda ponteiro, tamanho, counts e autor.
2. **S3 primeiro, índice depois.** Um crash entre as duas operações deixa um
   objeto órfão (inofensivo, coberto pela lifecycle policy), nunca uma linha
   apontando para um objeto inexistente.
3. **Restore é sempre um tenant novo.** Não existe "restore in-place": o slug é
   obrigatório e deve estar livre; a origem permanece intacta.
4. **Sem credenciais.** Tokens, hashes, segredos TOTP e sessões ficam fora do
   arquivo e do restore; a recuperação exige reconectar lojas e redefinir
   senhas.
5. **Backups contêm dados pessoais operacionais** (e-mail de agente, dados de
   comprador nos tickets). O bucket deve ter acesso restrito e SSE; o console
   só expõe metadados. `BACKUP_RETENTION_DAYS` (default **90**, `0` desabilita)
   é aplicado pelo job diário `queue.tenant.backup.purge` (`BACKUP_PURGE_CRON`,
   default `0 4 * * *`): o objeto S3 é apagado primeiro e só então a linha de
   `tenant_backups`. Se o S3 falhar, a linha é **mantida** (o ponteiro é a única
   trilha do objeto que ainda contém dados) e a próxima execução tenta de novo.
6. **`tenant_backups` tem FK `ON DELETE CASCADE`.** A purga LGPD do tenant
   remove as linhas de índice; os objetos seguem a política de retenção do
   bucket e a varredura diária de expiração.
7. **A purga é irreversível para os dados relacionais.** Um backup anterior
   permite recriar um workspace NOVO (nunca o original), desde que o objeto
   ainda exista no bucket.

## Pendências conhecidas

- **Binários não são copiados.** `message_attachments` restaurado guarda a
  `s3Uri` original; se o objeto já tiver sido apagado pela purga/lifecycle, o
  download falha. Copiar os binários para um prefixo do novo tenant é follow-up.
- **Senha temporária não é entregue.** O restore gera hash aleatório e marca
  `must_reset_password`, mas não envia e-mail. O operador usa o fluxo existente
  de `forgot-password`/`reset-password` (ou o ADMIN reenvia o convite); entregar
  o link automaticamente no restore é follow-up.
- **Retenção coberta por dois mecanismos.** O job diário
  `queue.tenant.backup.purge` expira `tenant_backups` + objetos pela idade
  (`BACKUP_RETENTION_DAYS`, default 90; `0` desabilita). A lifecycle policy do
  bucket continua recomendada como rede de segurança para objetos órfãos de
  execuções anteriores à criação do job.
- **Sem restore in-place.** Recuperar o workspace original exigiria apagar ou
  renomear o existente; o contrato atual sempre cria um slug novo.

## Testes

- `TenantBackup.test.ts` — backup sem segredos/PII bruta, counts, chave/metadata
  do S3 fake, listagem do índice, restore (slug/name normalizados, hashes
  aleatórios, 404 de objeto ausente, 422 de artefato inválido, 409 de slug).
- `TenantBackupPurge.test.ts` — cutoff estrito, batch (default 100), S3 antes do
  DB, falha S3 mantém a linha, retenção `0` é no-op e idempotência (segunda
  execução/linha já removida).
- `tenantBackupPurgeWiring.test.ts` — nomes de fila/job, cron diário 04:00,
  defaults/overrides de config e ausência de scheduler com retenção `0`.
- `repositories/tenant-restore.test.ts` — transação única, tenant novo,
  remapeamento de ids/FKs, agentes com `mustResetPassword`, contas
  `DISCONNECTED` sem tokens e desambiguação de chaves naturais globais.
- `tenant-backup-routes.test.ts` — HTTP 401/403/404/409/422 das três rotas.
