/**
 * Dump lógico do Postgres do stack de produção (docker compose).
 * Uso: node scripts/db-backup.mjs
 * Saída: backups/db-<timestamp>.sql (gitignored)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const COMPOSE = [
  'compose',
  '--env-file',
  '.env.prod',
  '-f',
  'docker-compose.prod.yml',
  'exec',
  '-T',
  'postgres',
];

const user = process.env.POSTGRES_USER ?? 'sac';
const database = process.env.POSTGRES_DB ?? 'sac_hub';
const file = `backups/db-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;

const dump = execFileSync(
  'docker',
  [...COMPOSE, 'pg_dump', '-U', user, '-d', database, '--clean', '--if-exists', '--no-owner'],
  { maxBuffer: 512 * 1024 * 1024 },
);
mkdirSync('backups', { recursive: true });
writeFileSync(file, dump);
console.log(`backup salvo: ${file} (${dump.length} bytes)`);
