/**
 * Restaura um dump lógico no Postgres do stack de produção (docker compose).
 * Uso: node scripts/db-restore.mjs backups/db-<timestamp>.sql
 *
 * ATENÇÃO: aplica DROP/CREATE do dump (--clean --if-exists). Use somente com a
 * aplicação parada ou em janela de manutenção.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('uso: node scripts/db-restore.mjs backups/db-<timestamp>.sql');
  process.exit(2);
}

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
const sql = readFileSync(file);

execFileSync('docker', [...COMPOSE, 'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'], {
  input: sql,
  maxBuffer: 512 * 1024 * 1024,
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log(`restaurado: ${file}`);
