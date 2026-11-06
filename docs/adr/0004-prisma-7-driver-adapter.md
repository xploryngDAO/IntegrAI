# ADR-0004 — Prisma 7 com `prisma-client` e driver adapter `@prisma/adapter-pg`

## Status

Aceito

## Data

2026-11-06

## Contexto

O projeto usava Prisma 6.19.3, que carregava o client gerado em `node_modules` e
lia `DATABASE_URL` do `.env` automaticamente. O `npm audit --omit=dev` apontava
advisories `high` na cadeia do Prisma (`deepmerge-ts` via `@prisma/config`),
corrigidos apenas em `prisma@7.10.1+` — um major que muda geração, configuração
e runtime.

Prisma 7 remove o query engine embarcado: todo client precisa de um **driver
adapter**. O client deixa de ser gerado em `node_modules` e passa a ser código
TypeScript no source tree, o que interage com `tsc`, Docker, CI e `.gitignore`.

## Decisão

1. **Atualizar para `prisma` / `@prisma/client` / `@prisma/adapter-pg` 7.10.1**
   (`packages/server/package.json`, devDependency na raiz).
2. **Generator `prisma-client` (não `prisma-client-js`)** em
   `prisma/schema.prisma`:
   `output = "../packages/server/src/generated/prisma"`, `moduleFormat = "cjs"`
   (o build do servidor é CommonJS) e `importFileExtension = ""`.
3. **Configuração no `prisma.config.ts`**, não no schema:
   `defineConfig` com `schema`, `migrations.path` e `migrations.seed`
   (`tsx prisma/seed.ts`). O datasource é anexado **só quando `DATABASE_URL`
   existe**, para que `prisma generate` funcione sem banco em `npm ci`, CI e
   build Docker; `migrate`/`db` continuam exigindo a variável. O arquivo importa
   `dotenv/config` porque o Prisma 7 não carrega `.env` sozinho.
4. **Driver adapter `@prisma/adapter-pg` sobre `pg`**
   (`packages/server/src/infrastructure/prisma/client.ts`): um client por URL,
   `PrismaPg` com `schema` e `max` derivados de `?schema=` e
   `?connection_limit=` (o `pg` não entende os parâmetros do Prisma), e
   `connectionTimeoutMillis: 5_000` para preservar o timeout que o Prisma 6
   aplicava. `createIsolatedPrismaClient` atende testes e o
   `disconnectAllPrismaClients` cobre shutdown.
5. **Client gerado é artefato de build, não de código-fonte.** O caminho
   `packages/server/src/generated/` está no `.gitignore` e `npm run
   prisma:generate` é obrigatório antes de `tsc`, testes e build. O CI
   (`.github/workflows/ci.yml`), o `security.yml` e os Dockerfiles de API e web
   executam `prisma generate` explicitamente. O entrypoint da API continua
   rodando `prisma migrate deploy` antes de subir.

## Alternativas consideradas

- **Permanecer no Prisma 6 e aceitar os advisories.** O uso de `@prisma/config`
  é de CLI (baixa explorabilidade), mas o achado ficaria aberto e o major seria
  adiado indefinidamente. A migração já estava planejada em PR separado
  (`docs/SECURITY.md` §7). Rejeitado.
- **Trocar de ORM (Drizzle/Kysely).** Reduziria o peso do Prisma, mas exigiria
  reescrever schema, migrations e queries de todo o servidor, sem ganho imediato
  para o produto. Rejeitado.
- **Manter `prisma-client-js` gerando em `node_modules`.** Evitaria o passo
  explícito de geração, mas não é o caminho suportado no v7 e voltaria a esconder
  o artefato. Rejeitado.
- **Manter `url` no `datasource` do schema.** Campo deprecated no v7 e mistura
  configuração de CLI com runtime. Rejeitado em favor do `prisma.config.ts`.
- **Criar o client sem driver adapter.** O v7 não traz query engine embarcado;
  não é uma opção suportada.

## Consequências

**Positivas**

- `npm audit --omit=dev` passa a **0 vulnerabilidades de produção** (restam
  advisories dev-only da cadeia de testes), conforme `docs/SECURITY.md` §15.
- Sem engine binário: imagem e instalação mais leves, e o client é TypeScript
  verificável pelo `tsc`.
- O pool de conexões passa a ser o do `pg`, com `connection_limit` mapeado
  explicitamente para `max` e timeout de conexão preservado.
- `prisma generate` independente de banco simplifica CI e build Docker.

**Negativas**

- O client gerado **não** existe no checkout: esquecer `prisma:generate` quebra
  typecheck/build. É um passo obrigatório em todo ambiente novo.
- Código gerado dentro de `src/` aumenta o custo de compilação e exige que
  `packages/server/src/generated/` continue gitignored.
- `prisma db seed` é explícito no v7; `migrate dev` não semeia mais.
- Semântica de conexão mudou (`connection_limit` → `max`, timeout padrão do
  `pg`): URLs antigas precisam do mapeamento feito em `client.ts`.
- Há drift documental: o cabeçalho de `prisma/schema.prisma` ainda diz
  "Prisma 6" e o README/PRODUCT_STATUS citam Prisma 6 em alguns trechos. Não
  afeta o build, mas confunde onboarding.

## Referências

- [`prisma.config.ts`](../../prisma.config.ts).
- [`prisma/schema.prisma`](../../prisma/schema.prisma) — generator e datasource.
- [`packages/server/src/infrastructure/prisma/client.ts`](../../packages/server/src/infrastructure/prisma/client.ts).
- [`packages/server/package.json`](../../packages/server/package.json).
- [`.gitignore`](../../.gitignore) — `packages/server/src/generated/`.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — `prisma:generate`
  antes de typecheck/test/build.
- [`packages/server/Dockerfile`](../../packages/server/Dockerfile) e
  [`apps/web/Dockerfile`](../../apps/web/Dockerfile).
- [`docs/SECURITY.md`](../SECURITY.md) §7 e §15.
