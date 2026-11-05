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
 * Run: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const EMAIL = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const NAME = (process.env.ADMIN_NAME ?? 'Administrador').trim();
const MIN_PASSWORD_LENGTH = 12;

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

  const agent = await prisma.agent.upsert({
    where: { email: EMAIL },
    update: {
      name: NAME,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
    },
    create: {
      email: EMAIL,
      name: NAME,
      passwordHash,
      role: 'ADMIN',
      avatarColor: '#6367c9',
      maxConcurrent: 20,
      isActive: true,
    },
  });

  console.log(`✓ Operador ADMIN pronto: ${agent.email} (${agent.name})`);

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
