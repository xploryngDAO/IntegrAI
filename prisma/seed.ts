/* eslint-disable no-console */
/**
 * Bootstrap do SAC Hub.
 *
 * Cria (ou atualiza) o primeiro operador ADMIN a partir das variáveis
 * `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `ADMIN_NAME`. NÃO cria lojas, pedidos,
 * atendimentos nem qualquer dado de demonstração: contas reais são conectadas
 * por OAuth/credenciais na tela `/accounts` e os atendimentos chegam pelos
 * webhooks dos marketplaces.
 *
 * Fase 4 (console interno): o operador de bootstrap recebe
 * `is_platform_admin = true` (acesso cross-tenant a `/api/v1/platform/*`).
 * Outros e-mails podem receber o mesmo privilégio via `PLATFORM_ADMIN_EMAILS`
 * (lista separada por vírgula) — o flag nunca é concedido por signup/convite.
 *
 * Run: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../packages/server/src/generated/prisma/client';

// Prisma ORM 7: the client talks through a driver adapter and no longer loads
// `.env` by itself (hence `dotenv/config` above).
const prisma = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: process.env.DATABASE_URL },
    { schema: 'public' },
  ),
});

const EMAIL = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const NAME = (process.env.ADMIN_NAME ?? 'Administrador').trim();
const MIN_PASSWORD_LENGTH = 12;

/**
 * `ENTERPRISE` practical ceiling, mirroring `PLAN_LIMITS.ENTERPRISE` from
 * `@sac/shared` (duplicated here so the seed never needs the built shared
 * package). The bootstrap workspace is the platform owner's own tenant.
 */
const ENTERPRISE_UNLIMITED = 1_000_000;

function platformAdminEmails(): string[] {
  const listed = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.includes('@'));

  // ADMIN_EMAIL is always a platform admin; the env list adds internal peers.
  return [...new Set([EMAIL, ...listed].filter((entry) => entry.length > 0))];
}

async function main(): Promise<void> {
  if (!EMAIL || !EMAIL.includes('@')) {
    throw new Error('ADMIN_EMAIL ausente ou inválido. Ex.: ADMIN_EMAIL=voce@suaempresa.com.br');
  }
  if (PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres (recebido ${PASSWORD.length}).`,
    );
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const platformAdmins = platformAdminEmails();
  const isPlatformAdmin = platformAdmins.includes(EMAIL);

  // The bootstrap workspace belongs to the platform owner: it is created as
  // ENTERPRISE so the internal console is never blocked by its own quota. An
  // existing tenant keeps whatever plan the console assigned (no surprise
  // downgrade/upgrade on every seed run).
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'integrai' },
    update: { name: 'IntegrAI', status: 'ACTIVE' },
    create: {
      slug: 'integrai',
      name: 'IntegrAI',
      status: 'ACTIVE',
      plan: 'ENTERPRISE',
      maxAccounts: ENTERPRISE_UNLIMITED,
      maxAgents: ENTERPRISE_UNLIMITED,
    },
  });

  // A workspace created before Fase 4 carries the FREE defaults from the
  // migration. The platform owner's own workspace is lifted to ENTERPRISE
  // exactly once (while the plan is still FREE): a plan chosen later in the
  // console is never overwritten by a seed rerun.
  if (tenant.plan === 'FREE') {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        plan: 'ENTERPRISE',
        maxAccounts: ENTERPRISE_UNLIMITED,
        maxAgents: ENTERPRISE_UNLIMITED,
      },
    });
    tenant.plan = 'ENTERPRISE';
    console.log(`✓ Tenant ${tenant.slug} promovido a ENTERPRISE (sem limite prático).`);
  }

  const agent = await prisma.agent.upsert({
    where: { email: EMAIL },
    update: {
      name: NAME,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      tenantId: tenant.id,
      isPlatformAdmin,
      // Bootstrap operator (ADMIN_EMAIL/ADMIN_PASSWORD) is trusted by design:
      // it never goes through the self-service signup verification flow.
      emailVerifiedAt: new Date(),
    },
    create: {
      email: EMAIL,
      name: NAME,
      passwordHash,
      role: 'ADMIN',
      avatarColor: '#6367c9',
      maxConcurrent: 20,
      isActive: true,
      isPlatformAdmin,
      tenantId: tenant.id,
      emailVerifiedAt: new Date(),
    },
  });

  // Additional platform admins already present in the database (for example a
  // second internal operator created by a previous seed/signup). Idempotent.
  const extraAdmins = platformAdmins.filter((entry) => entry !== EMAIL);
  if (extraAdmins.length > 0) {
    const promoted = await prisma.agent.updateMany({
      where: { email: { in: extraAdmins } },
      data: { isPlatformAdmin: true },
    });
    if (promoted.count > 0) {
      console.log(`✓ ${promoted.count} operador(es) promovido(s) a platform admin: ${extraAdmins.join(', ')}`);
    }
  }

  console.log(
    `✓ Operador ADMIN pronto: ${agent.email} (${agent.name}) · tenant ${tenant.slug} · platform admin: ${
      agent.isPlatformAdmin ? 'sim' : 'não'
    }`,
  );

  const counts = {
    agentes: await prisma.agent.count(),
    lojasConectadas: await prisma.marketplaceAccount.count(),
    atendimentos: await prisma.supportTicket.count(),
  };
  console.log('Estado atual do banco:', counts);
  console.log(
    'Nenhum dado de marketplace é semeado de propósito. Conecte suas lojas em /accounts para começar.',
  );
}

main()
  .catch((error) => {
    console.error('✗ Bootstrap falhou:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
