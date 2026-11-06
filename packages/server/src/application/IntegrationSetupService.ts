import type {
  ChannelRuntimeConfig,
  IClock,
  IIntegrationSetupService,
  IntegrationSetupChannel,
  IntegrationSetupGuide,
  Marketplace,
} from '@sac/shared';

/**
 * ============================================================================
 * IntegrationSetupService - Fase 2 onboarding: criar o app no portal
 * ============================================================================
 *
 * Answers "what exactly do I paste in Meli DevCenter / Shopee Open Platform /
 * Amazon Seller Central?" straight from the deployment configuration:
 *
 *  - `configured` / `missing` come from the SAME runtime config the adapters and
 *    the OAuth flows use, so a green check means the API can really start the
 *    authorization. `missing` carries environment variable NAMES only.
 *  - `appIdPublic` is the public application identifier (Meli App ID, Shopee
 *    partner id, Amazon application id). It is the value that already travels
 *    in the OAuth authorize URL, never a client secret.
 *  - `redirectUri` / `webhookUrl` are the exact strings to register. The
 *    redirect reflects what the OAuth start will actually send (configured
 *    value, APP_BASE_URL fallback); the webhook is derived from `APP_BASE_URL`
 *    plus the real ingress path (root `/webhooks/...`, no `/api/v1` prefix).
 *  - `webhookSecretEnv` names the signing secret variable (Shopee partner key,
 *    Amazon SES relay shared secret). The VALUE is never read for the response:
 *    the guide only checks whether it is present.
 *
 * No marketplace API is called and no credential is decrypted here, so the
 * endpoint is cheap and safe to poll during onboarding.
 */

/** Portal where each app is created (operator-facing). */
const MELI_PORTAL_URL = 'https://developers.mercadolivre.com.br/devcenter';
const SHOPEE_PORTAL_URL = 'https://open.shopee.com';
const AMAZON_PORTAL_URL = 'https://sellercentral.amazon.com/apps/manage';

/** Official registration/authorization documentation. */
const MELI_DOCS_URL = 'https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao';
const SHOPEE_DOCS_URL = 'https://open.shopee.com/documents/v2/v2.shop.auth_partner?module=95&type=1';
const AMAZON_DOCS_URL = 'https://developer-docs.amazon.com/sp-api/docs/registering-your-application';

/** Ingress paths mounted at the root (see `registerRootRoutes`). */
const MELI_WEBHOOK_PATH = '/webhooks/mercadolivre';
const SHOPEE_WEBHOOK_PATH = '/webhooks/shopee';
const AMAZON_WEBHOOK_PATH = '/webhooks/amazon/ses';

/** OAuth callbacks mounted under `/api/v1/accounts/oauth` (fallback only). */
const MELI_REDIRECT_PATH = '/api/v1/accounts/oauth/mercadolivre/callback';
const SHOPEE_REDIRECT_PATH = '/api/v1/accounts/oauth/shopee/callback';
const AMAZON_REDIRECT_PATH = '/api/v1/accounts/oauth/amazon/callback';

/** Webhook signing secrets, by variable NAME (values are never exposed). */
export const SHOPEE_WEBHOOK_SECRET_ENV = 'SHOPEE_PARTNER_KEY';
export const AMAZON_WEBHOOK_SECRET_ENV = 'AMAZON_SES_INBOUND_SHARED_SECRET';

/**
 * Meli topics shipped by `.env.example` (used only when the deployment did not
 * override `MELI_WEBHOOK_TOPICS`, keeping the steps actionable).
 */
const DEFAULT_MELI_TOPICS = ['questions', 'messages', 'claims', 'post_purchase', 'orders', 'shipments'];

/**
 * Shopee push codes from the Open Platform docs (the portal "Push" tab lists
 * them by code, so the guide uses the code + meaning the operator must tick).
 */
const SHOPEE_PUSH_TOPICS = [
  '2 (order status)',
  '3 (tracking)',
  '4 (sellerchat)',
  '6 (return)',
  '7 (cancellation)',
  '10 (shipping document)',
];

/** Amazon SP-API roles the messaging/orders/PII flows require. */
const AMAZON_ROLES = [
  'Product Listing',
  'Orders',
  'Buyer Communication (Messaging)',
  'Direct-to-Consumer Shipping',
  'Pricing',
];

/**
 * Onboarding order used by the wizard: Meli and Shopee connect in ~3 min, the
 * Amazon public app depends on an external review (DPP/security assessment).
 */
const CHANNEL_ORDER: readonly Marketplace[] = ['MERCADO_LIVRE', 'SHOPEE', 'AMAZON'];

export interface IntegrationSetupServiceDependencies {
  clock: IClock;
  /**
   * Channel runtime config (same object the adapters receive). Only public ids
   * and presence flags are read; secret values stay inside this service.
   */
  config: ChannelRuntimeConfig;
  /**
   * Raw `WEB_ORIGIN` env value. The env accepts a comma-separated list (SPA,
   * admin app, local dev); the guide exposes the FIRST origin.
   */
  webOrigin: string;
}

export class IntegrationSetupService implements IIntegrationSetupService {
  private readonly clock: IClock;
  private readonly config: ChannelRuntimeConfig;
  private readonly apiBaseUrl: string;
  private readonly webOrigin: string;

  constructor(deps: IntegrationSetupServiceDependencies) {
    this.clock = deps.clock;
    this.config = deps.config;
    this.apiBaseUrl = normalizeBaseUrl(deps.config.appBaseUrl);
    // Without a usable WEB_ORIGIN the API base is the best available origin.
    this.webOrigin = firstOrigin(deps.webOrigin) ?? this.apiBaseUrl;
  }

  guide(marketplace?: Marketplace): IntegrationSetupGuide {
    const channels = CHANNEL_ORDER.filter(
      (candidate) => marketplace === undefined || candidate === marketplace,
    ).map((candidate) =>
      candidate === 'MERCADO_LIVRE'
        ? this.describeMeli()
        : candidate === 'SHOPEE'
          ? this.describeShopee()
          : this.describeAmazon(),
    );

    return {
      generatedAt: this.clock.now().toISOString(),
      apiBaseUrl: this.apiBaseUrl,
      webOrigin: this.webOrigin,
      channels,
    };
  }

  /* ==================================================================== */
  /* Mercado Livre - DevCenter                                            */
  /* ==================================================================== */

  private describeMeli(): IntegrationSetupChannel {
    const clientId = readString(this.config.meli.clientId);
    const clientSecret = readString(this.config.meli.clientSecret);
    const missing: string[] = [];
    if (clientId === null) missing.push('MELI_CLIENT_ID');
    if (clientSecret === null) missing.push('MELI_CLIENT_SECRET');

    const redirectUri =
      readString(this.config.meli.redirectUri) ?? `${this.apiBaseUrl}${MELI_REDIRECT_PATH}`;
    const webhookUrl = `${this.apiBaseUrl}${MELI_WEBHOOK_PATH}`;
    const topics = effectiveTopics(this.config.meli.webhookTopics, DEFAULT_MELI_TOPICS);
    const steps: string[] = [];

    if (clientId === null) {
      steps.push(
        `Crie a aplicação em ${MELI_PORTAL_URL} (tipo "in-house" para uso próprio).`,
      );
      steps.push(
        'Copie o App ID para MELI_CLIENT_ID e o Secret para MELI_CLIENT_SECRET no ambiente da API e reinicie o processo.',
      );
    } else {
      steps.push(
        `App já identificado neste ambiente (App ID ${clientId}); confirme no DevCenter que ele continua ativo.`,
      );
      if (clientSecret === null) {
        steps.push(
          'Gere/copie o Secret do app no DevCenter, defina MELI_CLIENT_SECRET no ambiente da API e reinicie o processo.',
        );
      }
    }

    steps.push(`Em "Redirect URIs", cadastre exatamente ${redirectUri}.`);
    if (!redirectMatchesBase(redirectUri, this.apiBaseUrl)) {
      steps.push(
        `ATENÇÃO: MELI_REDIRECT_URI aponta para ${redirectUri}, fora de APP_BASE_URL (${this.apiBaseUrl}). ` +
          'Registre no portal exatamente o valor acima ou alinhe as duas variáveis antes de autorizar.',
      );
    }
    steps.push(
      `Em "Notifications", cadastre a Callback URL ${webhookUrl} e marque os tópicos: ${topics.join(', ')}.`,
    );
    steps.push(
      'O recebimento precisa responder 200 em menos de 500 ms: a API só enfileira o evento, então não adicione validação pesada no proxy.',
    );
    steps.push(
      'Em /accounts > Conectar loja > Mercado Livre, conclua o OAuth; o refresh token do Meli é rotativo (renovação a cada ~6 h sob lock).',
    );
    steps.push(
      'Webhooks do Mercado Livre não têm assinatura criptográfica: a loja é resolvida pelo user_id do payload, por isso não há segredo de webhook a configurar.',
    );
    steps.push(
      'Depois do deploy, rode `npm run doctor` (checks meli.config / meli.token / meli.identity).',
    );

    return {
      marketplace: 'MERCADO_LIVRE',
      configured: missing.length === 0,
      missing,
      appIdPublic: clientId,
      redirectUri,
      webhookUrl,
      oauthScopesOrTopics: topics,
      portalUrl: MELI_PORTAL_URL,
      docsUrl: MELI_DOCS_URL,
      steps,
      // Meli pushes are not signed (the account is resolved by the payload
      // user_id), so there is no webhook secret to configure.
      webhookSecretEnv: null,
      webhookSecretHint: null,
    };
  }

  /* ==================================================================== */
  /* Shopee - Open Platform v2                                            */
  /* ==================================================================== */

  private describeShopee(): IntegrationSetupChannel {
    const partnerId = readPositiveInteger(this.config.shopee.partnerId);
    const partnerKey = readString(this.config.shopee.partnerKey);
    const missing: string[] = [];
    if (partnerId === null) missing.push('SHOPEE_PARTNER_ID');
    if (partnerKey === null) missing.push('SHOPEE_PARTNER_KEY');

    const redirectUri =
      readString(this.config.shopee.redirectUri) ?? `${this.apiBaseUrl}${SHOPEE_REDIRECT_PATH}`;
    const webhookUrl = `${this.apiBaseUrl}${SHOPEE_WEBHOOK_PATH}`;
    const apiBase = normalizeBaseUrl(this.config.shopee.apiBase);
    const steps: string[] = [];

    if (partnerId === null) {
      steps.push(
        `Crie a aplicação em ${SHOPEE_PORTAL_URL} > App Management e copie o Partner ID para SHOPEE_PARTNER_ID.`,
      );
    } else {
      steps.push(
        `App já identificado neste ambiente (Partner ID ${partnerId}); confirme em App Management que ele segue ativo.`,
      );
    }
    if (partnerKey === null) {
      steps.push(
        'Copie a Partner Key do app para SHOPEE_PARTNER_KEY e reinicie a API: ela assina 100% das chamadas e valida o push.',
      );
    }

    steps.push(`Em "Redirect URL", cadastre exatamente ${redirectUri}.`);
    if (!redirectMatchesBase(redirectUri, this.apiBaseUrl)) {
      steps.push(
        `ATENÇÃO: SHOPEE_REDIRECT_URI aponta para ${redirectUri}, fora de APP_BASE_URL (${this.apiBaseUrl}). ` +
          'Registre no portal exatamente o valor acima ou alinhe as duas variáveis antes de autorizar.',
      );
    }
    steps.push(
      `Em "Push", cadastre ${webhookUrl} e habilite os push codes: ${SHOPEE_PUSH_TOPICS.join(', ')}.`,
    );
    steps.push(
      'A assinatura do push é HMAC-SHA256(URL pública completa + "|" + rawBody) com a Partner Key; mantenha o NTP sincronizado (skew < 5 min) e preserve o corpo bruto no proxy.',
    );
    if (isSandbox(apiBase)) {
      steps.push(
        `SHOPEE_API_BASE está em sandbox (${apiBase}): use as credenciais de teste do app; para produção aponte para https://partner.shopeemobile.com.`,
      );
    }
    steps.push(
      'Em /accounts > Conectar loja > Shopee, autorize via auth_partner; o refresh token é single-use (renovação a cada 3h30 sob lock).',
    );
    steps.push(
      'Depois do deploy, rode `npm run doctor` (checks shopee.config / shopee.clock / shopee.sign).',
    );

    return {
      marketplace: 'SHOPEE',
      configured: missing.length === 0,
      missing,
      appIdPublic: partnerId,
      redirectUri,
      webhookUrl,
      oauthScopesOrTopics: [...SHOPEE_PUSH_TOPICS],
      portalUrl: SHOPEE_PORTAL_URL,
      docsUrl: SHOPEE_DOCS_URL,
      steps,
      webhookSecretEnv: SHOPEE_WEBHOOK_SECRET_ENV,
      webhookSecretHint:
        'A Partner Key é o segredo do webhook: configure SHOPEE_PARTNER_KEY com a chave do app (a mesma que assina as chamadas). ' +
        'Rotacione no portal e atualize a variável quando necessário; o valor nunca é retornado por esta API.',
    };
  }

  /* ==================================================================== */
  /* Amazon - SP-API (public app + LWA) / Seller Central                  */
  /* ==================================================================== */

  private describeAmazon(): IntegrationSetupChannel {
    const appId = readString(this.config.amazon.appId);
    const lwaClientId = readString(this.config.amazon.lwaClientId);
    const lwaClientSecret = readString(this.config.amazon.lwaClientSecret);
    const missing: string[] = [];

    if (appId === null) {
      // The public app does not exist yet: the OAuth flow is blocked by
      // AMAZON_APP_ID alone, and listing LWA variables now would be noise.
      missing.push('AMAZON_APP_ID');
    } else {
      // The LWA pair is issued together with the public app, so once the app id
      // exists a missing LWA credential is a real blocker for the code exchange.
      if (lwaClientId === null) missing.push('AMAZON_LWA_CLIENT_ID');
      if (lwaClientSecret === null) missing.push('AMAZON_LWA_CLIENT_SECRET');
    }

    const redirectUri =
      readString(this.config.amazon.appRedirectUri) ?? `${this.apiBaseUrl}${AMAZON_REDIRECT_PATH}`;
    const webhookUrl = `${this.apiBaseUrl}${AMAZON_WEBHOOK_PATH}`;
    const steps: string[] = [];

    if (appId === null) {
      steps.push(
        'Pré-requisitos: conta de vendedor profissional (contas individuais não criam apps SP-API) e usuário principal da conta.',
      );
      steps.push(
        'Registre-se como desenvolvedor privado no Solution Provider Portal (Register as a developer > Private seller application), aceite AUP/DPP e responda o security assessment.',
      );
      steps.push(
        'Crie o app público em Seller Central > Apps and Services > Develop Apps > Add new app client; copie o Application ID para AMAZON_APP_ID e o LWA client ID/secret para AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET.',
      );
      steps.push(
        'Sem AMAZON_APP_ID o botão "Autorizar na Amazon" fica indisponível (409 AMAZON_OAUTH_NOT_CONFIGURED); o modo privado com refresh token LWA manual continua funcionando em /accounts.',
      );
    } else {
      steps.push(
        `App público já configurado (AMAZON_APP_ID ${appId}); confirme em Developer Central/Seller Central que ele está aprovado e publicado.`,
      );
      if (missing.length > 0) {
        steps.push(
          `Complete AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET com as credenciais LWA do app (faltando: ${missing.join(', ')}) e reinicie a API.`,
        );
      }
    }

    steps.push(`Habilite as roles do app: ${AMAZON_ROLES.join(', ')}.`);
    steps.push(
      `Cadastre no app o OAuth redirect exatamente ${redirectUri} e autorize a loja em /accounts > Autorizar na Amazon.`,
    );
    if (!redirectMatchesBase(redirectUri, this.apiBaseUrl)) {
      steps.push(
        `ATENÇÃO: AMAZON_APP_REDIRECT_URI aponta para ${redirectUri}, fora de APP_BASE_URL (${this.apiBaseUrl}). ` +
          'Registre exatamente o valor acima no app ou alinhe as duas variáveis antes de autorizar.',
      );
    }
    steps.push(
      `Relay de e-mail de entrada: aponte a action HTTPS/SNS do rule set do SES para ${webhookUrl} e faça o relay assinar o corpo bruto no header x-sac-signature.`,
    );
    steps.push(
      'Dados restritos do comprador (buyerInfo/shippingAddress) exigem RDT e DPP aceito; sem isso o pedido chega sem PII e o atendimento mostra o aviso de dados protegidos.',
    );
    steps.push(
      'Saída de e-mail: use o relay SMTP aprovado em Seller Central > Messages (rota 1); SES direto ao comprador é proibido.',
    );
    steps.push(
      'Depois do deploy, rode `npm run doctor` (checks amazon.config / amazon.lwa / amazon.participations).',
    );

    return {
      marketplace: 'AMAZON',
      configured: missing.length === 0,
      missing,
      appIdPublic: appId,
      redirectUri,
      webhookUrl,
      oauthScopesOrTopics: [...AMAZON_ROLES],
      portalUrl: AMAZON_PORTAL_URL,
      docsUrl: AMAZON_DOCS_URL,
      steps,
      webhookSecretEnv: AMAZON_WEBHOOK_SECRET_ENV,
      webhookSecretHint:
        'Configure AMAZON_SES_INBOUND_SHARED_SECRET com um segredo HMAC-SHA256 forte e faça o relay SES assinar o corpo bruto; ' +
        'o valor nunca é retornado por esta API e deve ser rotacionado junto com o relay.',
    };
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

/** Non-empty string (or finite number) -> trimmed string; otherwise `null`. */
function readString(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Shopee partner id: `0` is the "not configured" sentinel of the env schema. */
function readPositiveInteger(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? String(Math.trunc(value)) : null;
  }
  const text = readString(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.trunc(parsed)) : null;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** First non-empty entry of the comma-separated `WEB_ORIGIN`. */
function firstOrigin(value: string): string | null {
  const [first] = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return first !== undefined ? normalizeBaseUrl(first) : null;
}

function effectiveTopics(configured: string[], fallback: readonly string[]): string[] {
  const topics = configured.map((topic) => topic.trim()).filter((topic) => topic.length > 0);
  return topics.length > 0 ? topics : [...fallback];
}

/**
 * `true` when the redirect the OAuth start will send belongs to this API.
 *
 * A host-only comparison would flag legitimate deployments behind another
 * hostname; the point here is to catch the common staging/production mistake of
 * leaving `*_REDIRECT_URI` on `localhost` (or on the old domain).
 */
function redirectMatchesBase(redirectUri: string, apiBaseUrl: string): boolean {
  if (apiBaseUrl.length === 0) return true;
  return redirectUri.startsWith(apiBaseUrl);
}

function isSandbox(apiBase: string): boolean {
  return /test-stable|sandbox/i.test(apiBase);
}
