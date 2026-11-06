/**
 * Verifica o SMTP configurado e envia um e-mail de teste.
 *
 * Uso:
 *   node scripts/email-check.mjs --to=voce@empresa.com
 *   node scripts/email-check.mjs            # envia para SMTP_FROM
 *
 * Lê SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM do ambiente (use
 * `node --env-file=.env.prod scripts/email-check.mjs` no host).
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const arg = (name) => process.argv.find((entry) => entry.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const to = arg('to') ?? process.env.SMTP_FROM ?? '';
const from = process.env.SMTP_FROM ?? '';
const host = process.env.SMTP_HOST ?? '';
const port = Number(process.env.SMTP_PORT ?? 587);
const secure = process.env.SMTP_SECURE === 'true';
const user = process.env.SMTP_USER ?? '';
const password = process.env.SMTP_PASSWORD ?? '';

if (host.length === 0) {
  console.error('SMTP_HOST não configurado. Defina SMTP_HOST/SMTP_PORT/SMTP_FROM (e USER/PASSWORD se exigido).');
  process.exit(2);
}
if (to.length === 0) {
  console.error('Destinatário ausente: use --to=email@dominio.com ou defina SMTP_FROM.');
  process.exit(2);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: user.length > 0 ? { user, pass: password } : undefined,
});

const startedAt = Date.now();
try {
  await transporter.verify();
  console.log(`[ok] conexão SMTP com ${host}:${port} (secure=${secure})`);

  const info = await transporter.sendMail({
    from,
    to,
    subject: '[IntegrAI] teste de SMTP',
    text: `Teste de entrega do IntegrAI em ${new Date().toISOString()}.\nSe você recebeu esta mensagem, o SMTP está pronto para convites, verificação e reset de senha.`,
  });
  console.log(`[ok] e-mail aceito pelo servidor em ${Date.now() - startedAt} ms (id=${info.messageId ?? 'n/a'})`);
  console.log(`[info] destinatário: ${to}`);
  console.log('[info] Confira a caixa de entrada/spam. Se usar SES, valide também SPF/DKIM/DMARC do domínio.');
} catch (error) {
  console.error('[erro] falha no SMTP:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  transporter.close();
}
