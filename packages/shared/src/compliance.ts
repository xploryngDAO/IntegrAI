import type { Marketplace } from './enums';

/**
 * Cross-channel outbound policy engine.
 *
 * All three marketplaces forbid steering buyers off-platform. This module is the
 * single implementation of those guardrails: adapters run it before sending and
 * the HTTP layer runs it on every keystroke to drive the composer's realtime
 * validation. It is pure (no I/O) so it is safe to run in the browser bundle and
 * in unit tests.
 */

export type PolicySeverity = 'BLOCK' | 'WARN';

export interface PolicyViolation {
  code: string;
  severity: PolicySeverity;
  message: string;
  field: 'body' | 'subject' | 'attachment';
  match?: string;
}

export interface OutboundPolicyInput {
  text: string;
  html?: string | null;
  subject?: string | null;
  marketplace: Marketplace;
  /** Domains the platform explicitly allows in buyer messages. */
  allowedLinkDomains?: string[];
}

export interface OutboundPolicyResult {
  violations: PolicyViolation[];
  blocked: boolean;
  sanitizedText: string;
  sanitizedHtml: string | null;
  notes: string[];
}

export interface MarketplacePolicyRules {
  /** Domains that may appear as links without tripping the guardrail. */
  allowedLinkDomains: string[];
  /** Human-facing private contact channels that are always blocked. */
  blockedPhrases: RegExp[];
  /** Whether plain e-mail addresses in the body must be blocked. */
  blockEmailAddresses: boolean;
  /** Whether tracking pixels / 1x1 beacons must be stripped. */
  stripTrackingPixels: boolean;
  /** Whether platform-mandated auto-responder detection applies. */
  blockAutoResponder: boolean;
  label: string;
}

const WHATSAPP_PATTERNS = [
  /\bwhats\s*app\b/i,
  /\bwhatsapp\b/i,
  /\bwa\.me\//i,
  /\bt\.me\//i,
  /\btelegram\b/i,
  /\binstagram\b/i,
];

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const BARE_DOMAIN_REGEX = /\b(?:www\.)?[a-z0-9][a-z0-9-]{1,60}\.(?:com|com\.br|net|org|io|me|shop|store|link|app)(?:\/[^\s<>"')]*)?/gi;
const TRACKING_PIXEL_REGEX = /<img[^>]+(?:width\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?)[^>]*>/gi;
const TRACKING_PIXEL_ALT_REGEX = /<img[^>]*(?:tracking|pixel|beacon|open\.gif)[^>]*>/gi;

const AUTO_RESPONDER_PATTERNS = [
  /resposta\s+autom[áa]tica/i,
  /mensagem\s+autom[áa]tica/i,
  /auto[\s-]?reply/i,
  /out\s+of\s+(?:the\s+)?office/i,
  /estou\s+em\s+f[ée]rias/i,
  /este\s+e-?mail\s+foi\s+gerado\s+automaticamente/i,
];

export const MARKETPLACE_POLICY: Record<Marketplace, MarketplacePolicyRules> = {
  AMAZON: {
    label: 'Amazon Buyer-Seller Messaging Policy',
    allowedLinkDomains: ['amazon.com', 'amazon.com.br', 'amazon.com.mx', 'amazon.ca', 'amazon.co.uk'],
    blockedPhrases: WHATSAPP_PATTERNS,
    blockEmailAddresses: true,
    stripTrackingPixels: true,
    blockAutoResponder: true,
  },
  MERCADO_LIVRE: {
    label: 'Mercado Livre Messaging Policy',
    allowedLinkDomains: [
      'mercadolivre.com.br',
      'mercadolivre.com',
      'mercadopago.com.br',
      'mercadopago.com',
      'meli.com.br',
    ],
    blockedPhrases: [...WHATSAPP_PATTERNS, /\bamericanas\b/i, /\bmagalu\b/i, /\bshopee\b/i],
    blockEmailAddresses: true,
    stripTrackingPixels: true,
    blockAutoResponder: true,
  },
  SHOPEE: {
    label: 'Shopee Chat Policy (CRR protected)',
    allowedLinkDomains: ['shopee.com.br', 'shopee.com', 'shopee.com.my', 'shp.ee'],
    blockedPhrases: [...WHATSAPP_PATTERNS, /\bmercado\s*livre\b/i, /\bmercadolivre\b/i, /\bamazon\b/i],
    blockEmailAddresses: true,
    stripTrackingPixels: true,
    blockAutoResponder: true,
  },
};

export function extractUrls(text: string): string[] {
  const matches = new Set<string>();
  for (const m of text.matchAll(URL_REGEX)) matches.add(m[0]);
  for (const m of text.matchAll(BARE_DOMAIN_REGEX)) {
    if (!/^https?:\/\//i.test(m[0])) matches.add(m[0]);
  }
  return [...matches];
}

export function extractEmailAddresses(text: string): string[] {
  return [...new Set([...text.matchAll(EMAIL_REGEX)].map((m) => m[0]))];
}

export function hostnameOf(candidate: string): string {
  const value = candidate.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.toLowerCase().replace(/^www\./, '').split('/')[0] ?? '';
  }
}

export function isDomainAllowed(candidate: string, allowedDomains: readonly string[]): boolean {
  const host = hostnameOf(candidate);
  if (!host) return false;
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase().replace(/^www\./, '');
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export function stripTrackingPixels(html: string): string {
  return html.replace(TRACKING_PIXEL_REGEX, '').replace(TRACKING_PIXEL_ALT_REGEX, '');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function containsAutoResponderMarker(text: string): boolean {
  return AUTO_RESPONDER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Detects an opt-out request ("não me envie mais mensagens", "stop messaging").
 * Amazon requires critical messages to be prefixed with `[Important]` when the
 * buyer opted out, so the composer surfaces this as a hint.
 */
export function detectOptOut(text: string): boolean {
  return [
    /opt[\s-]?out/i,
    /n[ãa]o\s+(?:me\s+)?(?:envie|mande|contate|perturbe)\s+mais/i,
    /pare\s+de\s+(?:me\s+)?enviar/i,
    /do\s+not\s+(?:contact|message|email)/i,
    /stop\s+messaging/i,
  ].some((pattern) => pattern.test(text));
}

/** Removes quoted reply history so we only persist the new content. */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^-{2,}\s*Mensagem original\s*-{2,}$/im,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^On .+ wrote:$/im,
    /^Em .+ escreveu:$/im,
    /^De:\s.+$/im,
    /^From:\s.+$/im,
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index > 0) cut = Math.min(cut, match.index);
  }
  return text.slice(0, cut).trim();
}

/** Removes Amazon boilerplate footers from inbound e-mails. */
export function stripAmazonEmailFooter(text: string): string {
  const footers = [
    /-{2,}\s*Mensagem original\s*-{2,}/i,
    /-{2,}\s*Original Message\s*-{2,}/i,
    /This email was sent from Amazon/i,
    /Este e-?mail foi enviado (?:pela|pelo) Amazon/i,
    /Please do not reply to this message/i,
    /N[ãa]o responda a esta mensagem/i,
  ];
  let result = text;
  for (const footer of footers) {
    const idx = result.search(footer);
    if (idx > 0) result = result.slice(0, idx);
  }
  return result.trim();
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/** Redacts e-mail addresses / phone numbers before anything reaches the logs. */
export function redactPiiForLogs(input: string): string {
  return input
    .replace(EMAIL_REGEX, (email) => maskEmail(email))
    .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g, '[phone]');
}

/**
 * Applies the marketplace guardrails to an outbound draft.
 *
 * - forbidden external links / e-mail addresses / off-platform contact channels
 *   are BLOCK violations (the composer disables Send);
 * - tracking pixels are stripped from HTML silently;
 * - auto-responder markers are WARN (agents may be pasting an OOO template).
 */
export function evaluateOutboundPolicy(input: OutboundPolicyInput): OutboundPolicyResult {
  const rules = MARKETPLACE_POLICY[input.marketplace];
  const allowed = [...rules.allowedLinkDomains, ...(input.allowedLinkDomains ?? [])];
  const violations: PolicyViolation[] = [];
  const notes: string[] = [];

  let text = input.text ?? '';
  let html = input.html ?? null;

  if (rules.stripTrackingPixels && html) {
    const stripped = stripTrackingPixels(html);
    if (stripped !== html) {
      notes.push('Tracking pixels removed from HTML body.');
      html = stripped;
    }
  }

  const scanText = html ? `${text}\n${htmlToText(html)}` : text;

  for (const url of extractUrls(scanText)) {
    if (!isDomainAllowed(url, allowed)) {
      violations.push({
        code: 'EXTERNAL_LINK',
        severity: 'BLOCK',
        field: 'body',
        message: `Link externo não permitido (${rules.label}). Apenas domínios oficiais do marketplace podem ser enviados.`,
        match: url,
      });
    }
  }

  if (rules.blockEmailAddresses) {
    for (const email of extractEmailAddresses(scanText)) {
      violations.push({
        code: 'EMAIL_IN_BODY',
        severity: 'BLOCK',
        field: 'body',
        message: 'Endereço de e-mail no corpo da mensagem é proibido pelas políticas do marketplace.',
        match: maskEmail(email),
      });
    }
  }

  for (const pattern of rules.blockedPhrases) {
    const match = scanText.match(pattern);
    if (match) {
      violations.push({
        code: 'OFF_PLATFORM_CONTACT',
        severity: 'BLOCK',
        field: 'body',
        message: `Canal de contato externo bloqueado: "${match[0]}". Mantenha a conversa na plataforma.`,
        match: match[0],
      });
    }
  }

  if (rules.blockAutoResponder && containsAutoResponderMarker(scanText)) {
    violations.push({
      code: 'AUTO_RESPONDER',
      severity: 'WARN',
      field: 'body',
      message: 'A mensagem contém marcadores de resposta automática; o marketplace proíbe auto-responders.',
    });
  }

  if (detectOptOut(scanText)) {
    notes.push(
      input.marketplace === 'AMAZON'
        ? 'Opt-out do comprador detectado: use a tag [Important] para mensagens críticas.'
        : 'Pedido de opt-out detectado: evite mensagens promocionais.',
    );
  }

  if (input.subject) {
    for (const email of extractEmailAddresses(input.subject)) {
      violations.push({
        code: 'EMAIL_IN_SUBJECT',
        severity: 'BLOCK',
        field: 'subject',
        message: 'Endereço de e-mail no assunto é proibido.',
        match: maskEmail(email),
      });
    }
  }

  // Strip tracking params (?utm_*) from otherwise allowed links to keep the
  // delivered payload clean, but never rewrite the buyer's own content.
  text = text.replace(/[?&](utm_[a-z_]+)=[^&\s]+/gi, '');

  return {
    violations,
    blocked: violations.some((v) => v.severity === 'BLOCK'),
    sanitizedText: text,
    sanitizedHtml: html,
    notes,
  };
}

/** Amazon requires the `[Important]` prefix when messaging opted-out buyers. */
export function applyImportantPrefix(subject: string, force: boolean): string {
  if (!force) return subject;
  const cleaned = subject.replace(/^\s*\[important\]\s*/i, '').trim();
  return `[Important] ${cleaned}`;
}

export function ensureReplySubject(subject: string): string {
  const trimmed = (subject || '').trim();
  if (!trimmed) return 'Re: sua mensagem';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
