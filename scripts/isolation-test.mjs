/**
 * Teste de isolamento multi-tenant (A ≠ B) contra a API publicada.
 *
 * Cria um segundo tenant com conta/operador/ticket próprios, verifica que a
 * sessão do tenant A não enxerga nada do B e limpa tudo no final.
 *
 * Uso: node scripts/isolation-test.mjs [apiBase] [email] [password]
 */
import { PrismaClient } from '@prisma/client';

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? process.env.ADMIN_PASSWORD ?? 'IntegrAI-Prod-2026!';
const prisma = new PrismaClient();

const B = {
  tenantId: '00000000-0000-4000-8000-0000000000b2',
  accountId: '00000000-0000-4000-8000-0000000000a2',
  agentId: '00000000-0000-4000-8000-0000000000c2',
  ticketId: '00000000-0000-4000-8000-0000000000d2',
  invitationId: '00000000-0000-4000-8000-0000000000e2',
  auditEventId: '00000000-0000-4000-8000-0000000000f2',
  sessionId: '00000000-0000-4000-8000-0000000000b3',
  slug: 'tenant-b-isolation-test',
  email: 'isolation-b@test.local',
  inviteEmail: 'isolation-invite-b@test.local',
};

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function seedTenantB() {
  await prisma.tenant.upsert({
    where: { slug: B.slug },
    update: { name: 'Tenant B (isolamento)' },
    create: { id: B.tenantId, slug: B.slug, name: 'Tenant B (isolamento)', status: 'ACTIVE' },
  });
  await prisma.marketplaceAccount.upsert({
    where: { id: B.accountId },
    update: { tenantId: B.tenantId },
    create: {
      id: B.accountId,
      tenantId: B.tenantId,
      marketplace: 'MERCADO_LIVRE',
      displayName: 'Loja B Isolamento',
      externalSellerId: 'iso-b-1',
      marketplaceSiteId: 'MLB',
      status: 'ACTIVE',
    },
  });
  await prisma.agent.upsert({
    where: { email: B.email },
    update: { tenantId: B.tenantId },
    create: {
      id: B.agentId,
      tenantId: B.tenantId,
      email: B.email,
      name: 'Operador B',
      passwordHash: 'x',
      role: 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#000000',
      maxConcurrent: 1,
      isActive: true,
    },
  });
  await prisma.supportTicket.upsert({
    where: { id: B.ticketId },
    update: { tenantId: B.tenantId },
    create: {
      id: B.ticketId,
      tenantId: B.tenantId,
      accountId: B.accountId,
      marketplace: 'MERCADO_LIVRE',
      ticketType: 'PRE_SALE',
      externalReferenceId: 'iso-b-1',
      status: 'UNREAD',
      priority: 'MEDIUM',
      slaDeadlineAt: new Date(Date.now() + 3_600_000),
    },
  });
  await prisma.invitation.create({
    data: {
      id: B.invitationId,
      tenantId: B.tenantId,
      email: B.inviteEmail,
      role: 'AGENT',
      tokenHash: 'isolation-invitation-token-hash',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  }).catch(() => undefined);
  await prisma.auditEvent.create({
    data: {
      id: B.auditEventId,
      tenantId: B.tenantId,
      actorId: B.agentId,
      actorEmail: B.email,
      action: 'isolation.test',
      resourceType: 'test',
      resourceId: B.ticketId,
      ip: '203.0.113.10',
      userAgent: 'isolation-test',
    },
  }).catch(() => undefined);
  await prisma.session.create({
    data: {
      id: B.sessionId,
      userId: B.agentId,
      tenantId: B.tenantId,
      refreshTokenHash: 'isolation-session-refresh-hash',
      userAgent: 'isolation-test',
      ip: '203.0.113.10',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  }).catch(() => undefined);
}

async function cleanup() {
  await prisma.session.deleteMany({ where: { id: B.sessionId } });
  await prisma.auditEvent.deleteMany({ where: { id: B.auditEventId } });
  await prisma.invitation.deleteMany({ where: { id: B.invitationId } });
  await prisma.supportTicket.deleteMany({ where: { id: B.ticketId } });
  await prisma.marketplaceAccount.deleteMany({ where: { id: B.accountId } });
  await prisma.agent.deleteMany({ where: { email: B.email } });
  await prisma.tenant.deleteMany({ where: { id: B.tenantId } });
}

async function main() {
  console.log(`API: ${API}`);
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = login.body?.data?.token;
  record('A-login', login.status === 200 && Boolean(token), `status ${login.status}`);
  if (!token) throw new Error('sem token do tenant A');
  const headers = { authorization: `Bearer ${token}` };

  await seedTenantB();

  const accounts = await api('/api/v1/accounts', { headers });
  const accountIds = (accounts.body?.data ?? []).map((account) => account.id);
  record('A-nao-ve-conta-B', !accountIds.includes(B.accountId), `contas=${accountIds.length}`);

  const tickets = await api('/api/v1/tickets?filter=ALL&page=1&pageSize=20', { headers });
  record('A-nao-ve-ticket-B', (tickets.body?.data?.total ?? 0) === 0, `total=${tickets.body?.data?.total}`);

  const detail = await api(`/api/v1/tickets/${B.ticketId}`, { headers });
  record('A-detalhe-ticket-B-404', detail.status === 404, `status ${detail.status}`);

  const mutation = await api(`/api/v1/tickets/${B.ticketId}/assign`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: B.agentId }),
  });
  record('A-mutacao-ticket-B-404', mutation.status === 404, `status ${mutation.status}`);

  const adminUsers = await api('/api/v1/admin/users?search=isolation', { headers });
  record(
    'A-admin-users-nao-ve-B',
    (adminUsers.body?.data?.total ?? -1) === 0,
    `total=${adminUsers.body?.data?.total}`,
  );

  const adminInvitations = await api('/api/v1/admin/invitations', { headers });
  record(
    'A-admin-convites-nao-ve-B',
    !(adminInvitations.body?.data?.items ?? []).some((item) => item.email === B.inviteEmail),
  );

  const adminLogs = await api('/api/v1/admin/audit-logs?action=isolation.test', { headers });
  record(
    'A-admin-logs-nao-ve-B',
    (adminLogs.body?.data?.total ?? -1) === 0,
    `total=${adminLogs.body?.data?.total}`,
  );

  const adminSessions = await api('/api/v1/admin/sessions?perPage=100', { headers });
  record(
    'A-admin-sessoes-nao-ve-B',
    !(adminSessions.body?.data?.items ?? []).some((item) => item.agentId === B.agentId),
  );

  const csvResponse = await fetch(`${API}/api/v1/admin/users/export.csv?search=isolation`, {
    headers,
  });
  const csvText = await csvResponse.text();
  record(
    'A-admin-csv-nao-exporta-B',
    csvResponse.status === 200 && !csvText.includes(B.email),
    `bytes=${csvText.length}`,
  );

  const patchUserB = await api(`/api/v1/admin/users/${B.agentId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ isActive: false }),
  });
  record('A-admin-patch-usuario-B-404', patchUserB.status === 404, `status ${patchUserB.status}`);

  const revokeInviteB = await api(`/api/v1/admin/invitations/${B.invitationId}`, {
    method: 'DELETE',
    headers,
  });
  record('A-admin-revoga-convite-B-404', revokeInviteB.status === 404, `status ${revokeInviteB.status}`);

  const revokeSessionB = await api(`/api/v1/admin/sessions/${B.sessionId}`, {
    method: 'DELETE',
    headers,
  });
  record('A-admin-revoga-sessao-B-404', revokeSessionB.status === 404, `status ${revokeSessionB.status}`);

  await cleanup();
  const leftover = await prisma.tenant.count({ where: { id: B.tenantId } });
  record('cleanup', leftover === 0, `tenants restantes=${leftover}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    console.error('Falha:', error instanceof Error ? error.message : error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
