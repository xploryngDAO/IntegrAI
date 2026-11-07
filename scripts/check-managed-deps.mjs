#!/usr/bin/env node
/**
 * Pré-checagem de dependências gerenciadas (Postgres/Redis) antes do deploy.
 *
 * Uso:
 *   DATABASE_URL='postgresql://...' REDIS_URL='rediss://...' node scripts/check-managed-deps.mjs
 *   node --env-file=.env.prod scripts/check-managed-deps.mjs
 *
 * Valida conexão/TLS/latência, versão do servidor e o estado das migrações Prisma
 * sem imprimir usuário/senha (apenas host:porta/banco).
 */
import { Client } from 'pg';
import Redis from 'ioredis';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

function describeUrl(raw) {
  try {
    const url = new URL(raw);
    const db = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.protocol}//${url.hostname}:${url.port || '(default)'}/${db}`;
  } catch {
    return '(URL inválida)';
  }
}

function fail(message) {
  console.error(`[erro] ${message}`);
  process.exit(1);
}

if (!dbUrl) fail('DATABASE_URL não definida');
if (!redisUrl) fail('REDIS_URL não definida');

const started = Date.now();
let db;
try {
  const host = (() => {
    try {
      return new URL(dbUrl).hostname;
    } catch {
      return '';
    }
  })();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  db = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 10_000,
    // Bancos gerenciados normalmente exigem TLS; `rejectUnauthorized:false`
    // evita falha por CA intermediária — valide o CA em produção se exigido.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  await db.connect();
  const version = await db.query('SELECT version() AS version');
  const migrations = await db.query(
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists",
  );
  let applied = 0;
  if (migrations.rows[0]?.exists === true) {
    const count = await db.query('SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL');
    applied = count.rows[0]?.count ?? 0;
  }
  console.log(`[ok] Postgres ${describeUrl(dbUrl)} — ${String(version.rows[0]?.version).slice(0, 60)}`);
  console.log(`[ok] migrações Prisma aplicadas: ${applied}${migrations.rows[0]?.exists === true ? '' : ' (banco novo)'}`);
} catch (error) {
  fail(`Postgres: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await db?.end().catch(() => undefined);
}

const redis = new Redis(redisUrl, {
  lazyConnect: true,
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
try {
  await redis.connect();
  const pong = await redis.ping();
  const info = await redis.info('server');
  const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? '?';
  if (pong !== 'PONG') throw new Error(`PING inesperado: ${pong}`);
  console.log(`[ok] Redis ${describeUrl(redisUrl)} — v${version}`);
} catch (error) {
  fail(`Redis: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  redis.disconnect();
}

console.log(`\n[ok] dependências gerenciadas acessíveis em ${Date.now() - started} ms.`);
