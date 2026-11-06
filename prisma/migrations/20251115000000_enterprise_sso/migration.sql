-- Enterprise SSO (OpenID Connect) por workspace.
--
-- Uma conexão por tenant (`tenant_id` UNIQUE): o `discover` por domínio de
-- e-mail precisa ser inequívoco. `provider` é só um preset de onboarding
-- (MICROSOFT | GOOGLE | OKTA | OIDC); o protocolo é o authorization-code flow
-- genérico com PKCE S256.
--
-- Notas de segurança
-- - `client_secret_enc` guarda o segredo do client cifrado com o AES-256-GCM
--   `SecretCipher` (mesmo formato `v1:<keyId>:...` das demais colunas `*_enc`).
--   NULL = public client (PKCE obrigatório). O valor NUNCA é devolvido pela API.
-- - `allowed_domains` é a allowlist de domínios de e-mail (lowercase ASCII).
--   Lista vazia não casa ninguém: SSO é deny-by-default.
-- - `group_role_map` mapeia grupo/app role do IdP -> AgentRole local;
--   `default_role` só é aplicado na criação (JIT) quando nenhum grupo casa.
-- - `enforce_sso` bloqueia login por senha para os membros do workspace; a
--   checagem roda DEPOIS de validar a senha (sem enumeração). Platform admin é
--   sempre isento (break-glass).
-- - `ON DELETE CASCADE`: a purga LGPD do workspace remove a conexão e os
--   segredos junto.
--
-- A migration é idempotente (`IF NOT EXISTS` + enum/constraint guardados) para
-- bancos que foram criados com `prisma db push`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SsoProvider') THEN
    CREATE TYPE "SsoProvider" AS ENUM ('MICROSOFT', 'GOOGLE', 'OKTA', 'OIDC');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "tenant_sso_connections" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "provider" "SsoProvider" NOT NULL,
  "issuer_url" VARCHAR(512) NOT NULL,
  "client_id" VARCHAR(255) NOT NULL,
  "client_secret_enc" TEXT,
  "redirect_uri" VARCHAR(512) NOT NULL,
  "scopes" VARCHAR(255) NOT NULL DEFAULT 'openid profile email',
  "allowed_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "group_role_map" JSONB NOT NULL DEFAULT '{}',
  "auto_provision" BOOLEAN NOT NULL DEFAULT true,
  "default_role" "AgentRole" NOT NULL DEFAULT 'AGENT',
  "enforce_sso" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_sso_connections_pkey" PRIMARY KEY ("id")
);

-- One workspace, one IdP (also serves `findByTenantId`).
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_sso_connections_tenant_id_key"
  ON "tenant_sso_connections"("tenant_id");

CREATE INDEX IF NOT EXISTS "tenant_sso_connections_enabled_idx"
  ON "tenant_sso_connections"("enabled");

CREATE INDEX IF NOT EXISTS "tenant_sso_connections_provider_idx"
  ON "tenant_sso_connections"("provider");

-- `discover?domain=` / `start?email=` filter `enabled = true AND allowed_domains @> {domain}`.
CREATE INDEX IF NOT EXISTS "tenant_sso_connections_allowed_domains_idx"
  ON "tenant_sso_connections" USING GIN ("allowed_domains");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenant_sso_connections_tenant_id_fkey'
  ) THEN
    ALTER TABLE "tenant_sso_connections"
      ADD CONSTRAINT "tenant_sso_connections_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
