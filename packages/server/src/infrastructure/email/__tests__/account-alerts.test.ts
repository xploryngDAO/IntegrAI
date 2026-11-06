import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@sac/shared';

import { SmtpEmailService } from '../email-service';

/**
 * Account-management alerts (`sendRoleChangedAlert` /
 * `sendAccount{Deactivated,Reactivated}Alert`).
 *
 * The SMTP transport is mocked on purpose: these tests lock the pt-BR
 * subject/body and the best-effort contract (never throws, never touches the
 * network in `NODE_ENV=test`), not the relay itself.
 */

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

class RecordingLogger implements ILogger {
  readonly debugs: string[] = [];
  readonly warnings: string[] = [];

  child(): ILogger {
    return this;
  }

  trace(): void {}
  debug(message: string): void {
    this.debugs.push(message);
  }
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {}
}

type BuildOptions = Partial<ConstructorParameters<typeof SmtpEmailService>[0]>;

function build(overrides: BuildOptions = {}) {
  const logger = new RecordingLogger();
  const service = new SmtpEmailService({
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    from: 'no-reply@integrai.test',
    nodeEnv: 'production',
    logger,
    ...overrides,
  });
  return { service, logger };
}

/** Single `sendMail` argument of the last delivery. */
function lastMail(): Record<string, string> {
  const calls = sendMail.mock.calls;
  return calls[calls.length - 1][0] as Record<string, string>;
}

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue(undefined);
});

describe('SmtpEmailService.sendRoleChangedAlert', () => {
  it('sends a pt-BR alert with the localized roles and the actor e-mail', async () => {
    const { service } = build();

    await service.sendRoleChangedAlert({
      to: 'ana@acme.test',
      name: 'Ana',
      previousRole: 'AGENT',
      newRole: 'ADMIN',
      changedBy: 'admin@acme.test',
      tenantName: 'Acme Ltda',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = lastMail();
    expect(mail).toMatchObject({
      from: 'no-reply@integrai.test',
      to: 'ana@acme.test',
      subject: 'Seu papel no workspace mudou - IntegrAI',
    });
    expect(mail.text).toContain('Olá, Ana!');
    expect(mail.text).toContain(
      'Seu papel no workspace Acme Ltda mudou de Atendente para Administrador.',
    );
    expect(mail.text).toContain('A alteração foi feita por admin@acme.test.');
    expect(mail.html).toContain('<strong>Administrador</strong>');
  });

  it('falls back to safe labels when name/changedBy/tenant are absent', async () => {
    const { service } = build();

    await service.sendRoleChangedAlert({
      to: 'ana@acme.test',
      previousRole: 'ADMIN',
      newRole: 'AGENT',
    });

    const mail = lastMail();
    expect(mail.text).toContain('Olá, olá!');
    expect(mail.text).toContain('Seu papel mudou de Administrador para Atendente.');
    expect(mail.text).toContain('A alteração foi feita por um administrador.');
  });

  it('escapes the operator name and workspace name in the HTML body', async () => {
    const { service } = build();

    await service.sendRoleChangedAlert({
      to: 'ana@acme.test',
      name: '<script>x</script>',
      previousRole: 'AGENT',
      newRole: 'SUPERVISOR',
      tenantName: 'Acme & Cia',
    });

    const mail = lastMail();
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(mail.html).toContain('Acme &amp; Cia');
    expect(mail.html).not.toContain('<script>');
  });
});

describe('SmtpEmailService.sendAccountDeactivatedAlert', () => {
  it('sends the deactivation alert to the affected operator', async () => {
    const { service } = build();

    await service.sendAccountDeactivatedAlert({
      to: 'bruno@acme.test',
      name: 'Bruno',
      changedBy: 'admin@acme.test',
      tenantName: 'Acme Ltda',
    });

    const mail = lastMail();
    expect(mail.subject).toBe('Sua conta foi desativada - IntegrAI');
    expect(mail.to).toBe('bruno@acme.test');
    expect(mail.text).toContain('Sua conta no workspace Acme Ltda foi desativada por admin@acme.test.');
    expect(mail.text).toContain('Você não conseguirá entrar');
  });
});

describe('SmtpEmailService.sendAccountReactivatedAlert', () => {
  it('sends the reactivation alert to the affected operator', async () => {
    const { service } = build();

    await service.sendAccountReactivatedAlert({
      to: 'carla@acme.test',
      name: 'Carla',
      changedBy: 'admin@acme.test',
      tenantName: 'Acme Ltda',
    });

    const mail = lastMail();
    expect(mail.subject).toBe('Sua conta foi reativada - IntegrAI');
    expect(mail.text).toContain('Sua conta no workspace Acme Ltda foi reativada por admin@acme.test.');
    expect(mail.text).toContain('Você já pode entrar no IntegrAI novamente.');
  });
});

describe('account alerts best-effort contract', () => {
  it('never throws when the relay rejects, only warning', async () => {
    const { service, logger } = build();
    sendMail.mockRejectedValueOnce(new Error('relay down'));

    await expect(
      service.sendRoleChangedAlert({
        to: 'ana@acme.test',
        previousRole: 'AGENT',
        newRole: 'ADMIN',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warnings).toContain('email.role_changed_alert.failed');
  });

  it('never touches SMTP when NODE_ENV=test', async () => {
    const { service, logger } = build({ nodeEnv: 'test' });

    await service.sendRoleChangedAlert({
      to: 'ana@acme.test',
      previousRole: 'AGENT',
      newRole: 'ADMIN',
    });
    await service.sendAccountDeactivatedAlert({ to: 'ana@acme.test' });
    await service.sendAccountReactivatedAlert({ to: 'ana@acme.test' });

    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.debugs).toEqual([
      'email.role_changed_alert.skipped_in_test',
      'email.account_deactivated_alert.skipped_in_test',
      'email.account_reactivated_alert.skipped_in_test',
    ]);
  });

  it('ignores an empty recipient', async () => {
    const { service } = build();

    await service.sendAccountReactivatedAlert({ to: '   ' });

    expect(sendMail).not.toHaveBeenCalled();
  });
});
