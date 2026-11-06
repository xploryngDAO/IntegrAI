import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import type { IEmailService, ILogger, NewSessionAlertEmail } from '@sac/shared';

/**
 * ============================================================================
 * SmtpEmailService
 * ============================================================================
 *
 * Transactional e-mail through the SMTP relay already configured by `SMTP_*`
 * (mailpit in development, SES/production relay in production).
 *
 * Behaviour guarantees:
 *  - a transporter is only built on the first real send (no connection at boot);
 *  - when SMTP is not configured the raw verification link is logged ONLY when
 *    `NODE_ENV !== 'production'` - production never leaks tokens to stdout;
 *  - `NODE_ENV=test` never performs network I/O (tests inject a fake service,
 *    this guard is the second line of defence).
 *
 * The local loopback relay (`localhost:1025`, mailpit's default) counts as "not
 * configured outside production": the default `.env` points there, and logging
 * the link keeps signup usable when no mailbox is attached.
 */

export interface SmtpEmailServiceOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  nodeEnv: 'development' | 'test' | 'production';
  logger: ILogger;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Product timezone: the alert states when the login happened in local time. */
const ALERT_TIME_ZONE = 'America/Sao_Paulo';

export class SmtpEmailService implements IEmailService {
  private readonly logger: ILogger;
  private transporter: Transporter | null = null;

  constructor(private readonly options: SmtpEmailServiceOptions) {
    this.logger = options.logger.child({ component: 'SmtpEmailService' });
  }

  /** True when a real SMTP delivery can be attempted. */
  isConfigured(): boolean {
    const host = (this.options.host ?? '').trim();
    if (host.length === 0) return false;
    if (LOOPBACK_HOSTS.has(host.toLowerCase())) {
      return this.options.nodeEnv === 'production';
    }
    return true;
  }

  async sendVerificationEmail(to: string, link: string, name?: string): Promise<void> {
    const recipient = (to ?? '').trim();
    if (recipient.length === 0) return;

    if (this.options.nodeEnv === 'test') {
      // Never reach a real SMTP server from tests.
      this.logger.debug('email.verification.skipped_in_test', { to: recipient });
      return;
    }

    if (!this.isConfigured()) {
      if (this.options.nodeEnv === 'production') {
        this.logger.error('email.smtp.not_configured', {
          hint: 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD (and SMTP_FROM) to deliver verification e-mails.',
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[email:dev] verification link for ${recipient}: ${link}`);
      return;
    }

    const subject = 'Confirme seu e-mail - IntegrAI';
    const greeting = name !== undefined && name.trim().length > 0 ? name.trim() : 'olá';
    const text = [
      `Olá, ${greeting}!`,
      '',
      'Confirme seu e-mail para ativar o acesso ao IntegrAI:',
      link,
      '',
      'O link expira em 24 horas e só pode ser usado uma vez.',
      'Se você não criou esta conta, ignore esta mensagem.',
    ].join('\n');
    const html = [
      `<p>Olá, ${escapeHtml(greeting)}!</p>`,
      '<p>Confirme seu e-mail para ativar o acesso ao IntegrAI:</p>',
      `<p><a href="${escapeHtml(link)}">Confirmar e-mail</a></p>`,
      '<p>O link expira em 24 horas e só pode ser usado uma vez.</p>',
      '<p>Se você não criou esta conta, ignore esta mensagem.</p>',
    ].join('\n');

    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: this.options.from,
      to: recipient,
      subject,
      text,
      html,
    });
  }

  async sendPasswordResetEmail(to: string, link: string, name?: string): Promise<void> {
    const recipient = (to ?? '').trim();
    if (recipient.length === 0) return;

    if (this.options.nodeEnv === 'test') {
      // Never reach a real SMTP server from tests.
      this.logger.debug('email.password_reset.skipped_in_test', { to: recipient });
      return;
    }

    if (!this.isConfigured()) {
      if (this.options.nodeEnv === 'production') {
        this.logger.error('email.smtp.not_configured', {
          hint: 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD (and SMTP_FROM) to deliver password reset e-mails.',
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[email:dev] password reset link for ${recipient}: ${link}`);
      return;
    }

    const subject = 'Redefina sua senha - IntegrAI';
    const greeting = name !== undefined && name.trim().length > 0 ? name.trim() : 'olá';
    const text = [
      `Olá, ${greeting}!`,
      '',
      'Recebemos um pedido para redefinir a senha da sua conta IntegrAI:',
      link,
      '',
      'O link expira em 30 minutos e só pode ser usado uma vez.',
      'Ao concluir, todas as suas sessões abertas serão encerradas.',
      'Se você não pediu a redefinição, ignore esta mensagem: sua senha continua a mesma.',
    ].join('\n');
    const html = [
      `<p>Olá, ${escapeHtml(greeting)}!</p>`,
      '<p>Recebemos um pedido para redefinir a senha da sua conta IntegrAI:</p>',
      `<p><a href="${escapeHtml(link)}">Redefinir senha</a></p>`,
      '<p>O link expira em 30 minutos e só pode ser usado uma vez.</p>',
      '<p>Ao concluir, todas as suas sessões abertas serão encerradas.</p>',
      '<p>Se você não pediu a redefinição, ignore esta mensagem: sua senha continua a mesma.</p>',
    ].join('\n');

    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: this.options.from,
      to: recipient,
      subject,
      text,
      html,
    });
  }

  async sendInvitationEmail(to: string, link: string, inviterName?: string): Promise<void> {
    const recipient = (to ?? '').trim();
    if (recipient.length === 0) return;

    if (this.options.nodeEnv === 'test') {
      // Never reach a real SMTP server from tests.
      this.logger.debug('email.invitation.skipped_in_test', { to: recipient });
      return;
    }

    if (!this.isConfigured()) {
      if (this.options.nodeEnv === 'production') {
        this.logger.error('email.smtp.not_configured', {
          hint: 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD (and SMTP_FROM) to deliver invitation e-mails.',
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[email:dev] invitation link for ${recipient}: ${link}`);
      return;
    }

    const subject = 'Convite para operar o IntegrAI';
    const inviter = inviterName !== undefined && inviterName.trim().length > 0
      ? inviterName.trim()
      : 'a equipe IntegrAI';
    const text = [
      'Olá!',
      '',
      `Você foi convidado por ${inviter} para operar o IntegrAI.`,
      'Defina sua senha e ative seu acesso pelo link:',
      link,
      '',
      'O convite expira em 7 dias e só pode ser usado uma vez.',
      'Se você não esperava este convite, ignore esta mensagem.',
    ].join('\n');
    const html = [
      '<p>Olá!</p>',
      `<p>Você foi convidado por ${escapeHtml(inviter)} para operar o IntegrAI.</p>`,
      '<p>Defina sua senha e ative seu acesso pelo link:</p>',
      `<p><a href="${escapeHtml(link)}">Aceitar convite</a></p>`,
      '<p>O convite expira em 7 dias e só pode ser usado uma vez.</p>',
      '<p>Se você não esperava este convite, ignore esta mensagem.</p>',
    ].join('\n');

    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: this.options.from,
      to: recipient,
      subject,
      text,
      html,
    });
  }

  /**
   * Security alert for a login from a device fingerprint (IP + user-agent) the
   * operator never used before.
   *
   * Best effort by contract: this method NEVER throws. A relay failure is only
   * logged (`email.new_session_alert.failed`) because the login already
   * succeeded; the caller also invokes it fire-and-forget. The dev fallback
   * (SMTP unset / loopback outside production) prints the alert instead of a
   * link - there is no token in this e-mail, only the device/IP/instant.
   */
  async sendNewSessionAlert(input: NewSessionAlertEmail): Promise<void> {
    const recipient = (input.to ?? '').trim();
    if (recipient.length === 0) return;

    const ip = (input.ip ?? '').trim();
    const ipLabel = ip.length > 0 ? ip : 'não identificado';
    const deviceLabel = describeDevice(input.userAgent);
    const whenLabel = formatAlertInstant(input.at);
    const tenantName = (input.tenantName ?? '').trim();

    if (this.options.nodeEnv === 'test') {
      // Never reach a real SMTP server from tests.
      this.logger.debug('email.new_session_alert.skipped_in_test', { to: recipient });
      return;
    }

    if (!this.isConfigured()) {
      if (this.options.nodeEnv === 'production') {
        this.logger.error('email.smtp.not_configured', {
          hint: 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD (and SMTP_FROM) to deliver new session alerts.',
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[email:dev] new session alert for ${recipient}: device=${deviceLabel} ip=${ipLabel} at=${whenLabel}`,
      );
      return;
    }

    const subject = 'Novo acesso à sua conta IntegrAI';
    const greeting = input.name !== undefined && input.name.trim().length > 0
      ? input.name.trim()
      : 'olá';
    const workspaceSuffix = tenantName.length > 0 ? ` no workspace ${tenantName}` : '';
    const text = [
      `Olá, ${greeting}!`,
      '',
      `Detectamos um novo acesso à sua conta IntegrAI${workspaceSuffix}.`,
      '',
      `Dispositivo: ${deviceLabel}`,
      `Endereço IP: ${ipLabel}`,
      `Data e hora: ${whenLabel} (horário de Brasília)`,
      '',
      'Se foi você, nenhuma ação é necessária.',
      'Se você não reconhece este acesso, troque sua senha imediatamente e encerre',
      'as sessões ativas em Configurações > Segurança.',
    ].join('\n');
    const html = [
      `<p>Olá, ${escapeHtml(greeting)}!</p>`,
      `<p>Detectamos um novo acesso à sua conta IntegrAI${escapeHtml(workspaceSuffix)}.</p>`,
      '<ul>',
      `<li><strong>Dispositivo:</strong> ${escapeHtml(deviceLabel)}</li>`,
      `<li><strong>Endereço IP:</strong> ${escapeHtml(ipLabel)}</li>`,
      `<li><strong>Data e hora:</strong> ${escapeHtml(whenLabel)} (horário de Brasília)</li>`,
      '</ul>',
      '<p>Se foi você, nenhuma ação é necessária.</p>',
      '<p>Se você não reconhece este acesso, <strong>troque sua senha imediatamente</strong> e encerre as sessões ativas em Configurações &gt; Segurança.</p>',
    ].join('\n');

    try {
      const transporter = this.getTransporter();
      await transporter.sendMail({
        from: this.options.from,
        to: recipient,
        subject,
        text,
        html,
      });
    } catch (error) {
      // Best effort: the login must never fail because the alert could not be
      // delivered. No token/link exists here, so the warning is PII-free beyond
      // the recipient address (already known to the operator).
      this.logger.warn('email.new_session_alert.failed', {
        to: recipient,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getTransporter(): Transporter {
    if (this.transporter !== null) return this.transporter;

    const user = this.options.user?.trim();
    const password = this.options.password ?? '';
    this.transporter = nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      ...(user !== undefined && user.length > 0
        ? { auth: { user, pass: password } }
        : {}),
    });
    return this.transporter;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Raw user-agent (already truncated at the session boundary) or a safe label. */
function describeDevice(userAgent: string | null | undefined): string {
  const raw = (userAgent ?? '').trim();
  return raw.length > 0 ? raw : 'Dispositivo não identificado';
}

/**
 * Renders the login instant in the product timezone. The formatter is built on
 * demand (cheap, cached by the engine) and falls back safely if `at` is invalid
 * so a malformed value can never turn the best-effort alert into a throw.
 */
function formatAlertInstant(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return 'data não disponível';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: ALERT_TIME_ZONE,
  }).format(at);
}
