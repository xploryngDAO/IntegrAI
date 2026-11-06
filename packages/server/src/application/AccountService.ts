import { createHmac, randomBytes } from 'node:crypto';

import { MARKETPLACE_LABEL, redactPiiForLogs } from '@sac/shared';
import type {
  AccountStatus,
  ChannelRuntimeConfig,
  ConnectAccountRequest,
  ConnectorDescriptor,
  IAccountRepository,
  IAdapterRegistry,
  ICache,
  IClock,
  IHttpClient,
  ILogger,
  IPlanLimitService,
  IRealtimePublisher,
  ISecretCipher,
  IAccountService,
  Marketplace,
  MarketplaceAccountRecord,
  OAuthCallbackInput,
  OAuthStartResult,
} from '@sac/shared';
import { AmazonOAuthNotConfiguredError, MarketplaceApiError, NotFoundError, ValidationError } from '@sac/shared';

/**
 * ============================================================================
 * AccountService
 * ============================================================================
 *
 * Store onboarding for the three channels:
 *  - Amazon: HYBRID — OAuth consent in Seller Central (`AMAZON_APP_ID`) or the
 *    legacy self-authorized LWA refresh token + verified SMTP sender + SES
 *    inbound route.
 *  - Mercado Livre: OAuth2 authorization-code (`auth.mercadolivre.com.br`).
 *  - Shopee: OAuth2 shop authorization with partner-key HMAC signature.
 *
 * OAuth `state` is a signed, single-use token: the payload is signed with the
 * deterministic HMAC exposed by `ISecretCipher.hash` and stored in Redis for
 * 10 minutes. Completing with an expired/tampered/replayed state fails.
 */

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_CACHE_PREFIX = 'sac:oauth:state:';
const MELI_AUTHORIZE_URL = 'https://auth.mercadolivre.com.br/authorization';
const DEFAULT_SITE_ID = 'MLB';
const DEFAULT_AMAZON_AUTHORIZE_URL = 'https://sellercentral.amazon.com/apps/authorize/consent';
const AMAZON_OAUTH_NOT_CONFIGURED_REMEDIATION =
  'Configure AMAZON_APP_ID (and AMAZON_LWA_CLIENT_ID/AMAZON_LWA_CLIENT_SECRET) in the API ' +
  'environment, register AMAZON_APP_REDIRECT_URI in Seller Central, then restart the API.';
const AMAZON_DEFAULT_TOKEN_TTL_SECONDS = 3_600;

export interface AccountServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  cipher: ISecretCipher;
  http: IHttpClient;
  config: ChannelRuntimeConfig;
  adapters: IAdapterRegistry;
  realtime?: IRealtimePublisher;
  /**
   * Fase 4 quota gate (`max_accounts`). Optional only for legacy unit harnesses;
   * the container always wires it, and without it new stores bypass the plan.
   */
  planLimits?: IPlanLimitService;
  repos: {
    accounts: IAccountRepository;
  };
}

interface OAuthStatePayload {
  tenantId?: string | null;
  marketplace: Marketplace;
  displayName: string;
  nonce: string;
  issuedAt: number;
}

interface MeliTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: number | string;
  scope?: string;
}

interface MeliUserResponse {
  id?: number | string;
  site_id?: string;
  nickname?: string;
  email?: string;
}

interface ShopeeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  request_id?: string;
  shop_id?: number | string;
  error?: string;
  message?: string;
}

interface AmazonLwaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class AccountService implements IAccountService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly cipher: ISecretCipher;
  private readonly http: IHttpClient;
  private readonly config: ChannelRuntimeConfig;
  private readonly adapters: IAdapterRegistry;
  private readonly realtime: IRealtimePublisher | null;
  private readonly accounts: IAccountRepository;
  private readonly planLimits: IPlanLimitService | undefined;

  constructor(deps: AccountServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AccountService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.cipher = deps.cipher;
    this.http = deps.http;
    this.config = deps.config;
    this.adapters = deps.adapters;
    this.realtime = deps.realtime ?? null;
    this.accounts = deps.repos.accounts;
    this.planLimits = deps.planLimits;
  }

  /* ==================================================================== */
  /* Query                                                                */
  /* ==================================================================== */

  async listAccounts(tenantId?: string | null): Promise<
    Array<{
      id: string;
      marketplace: Marketplace;
      displayName: string;
      externalSellerId: string;
      marketplaceSiteId: string;
      status: string;
      channelConfig: Record<string, unknown>;
      tokenExpiresAt: string | null;
      authExpiresAt: string | null;
    }>
  > {
    // undefined = chamada interna (todos os tenants); null = sessao sem tenant -> nada.
    if (tenantId === null) return [];
    const accounts =
      tenantId === undefined ? await this.accounts.list() : await this.accounts.list({ tenantId });
    return accounts
      .map((account) => ({
        id: account.id,
        marketplace: account.marketplace,
        displayName: account.displayName,
        externalSellerId: account.externalSellerId,
        marketplaceSiteId: account.marketplaceSiteId,
        status: account.status,
        channelConfig: account.channelConfig ?? {},
        tokenExpiresAt: account.tokenExpiresAt ? account.tokenExpiresAt.toISOString() : null,
        authExpiresAt: account.authExpiresAt ? account.authExpiresAt.toISOString() : null,
      }))
      .sort((a, b) => a.marketplace.localeCompare(b.marketplace));
  }

  describeConnectors(): ConnectorDescriptor[] {
    return [this.describeAmazon(), this.describeMeli(), this.describeShopee()];
  }

  private describeAmazon(): ConnectorDescriptor {
    const appId = readString(this.config.amazon.appId);
    // The connector list is the UI capability probe: a non-null template means
    // "Autorizar na Amazon" is available in this environment. The manual LWA
    // path stays advertised (authMode HYBRID) for private-app deployments.
    const authorizeUrlTemplate =
      appId === null
        ? null
        : `${(this.config.amazon.oauthAuthorizeUrl ?? DEFAULT_AMAZON_AUTHORIZE_URL).replace(
            /\/+$/,
            '',
          )}?application_id=${encodeURIComponent(appId)}&state=<state>&version=beta`;

    return {
      marketplace: 'AMAZON',
      authMode: 'HYBRID',
      fields: [
        {
          key: 'displayName',
          label: 'Nome da loja',
          type: 'text',
          required: true,
          placeholder: 'Amazon BR - Loja Principal',
          helpText: 'Identificação interna desta conexão no SAC Hub.',
        },
        {
          key: 'externalSellerId',
          label: 'Seller ID',
          type: 'text',
          required: true,
          placeholder: 'A2Q3Y263D00KWC',
          helpText: 'Seller ID (Merchant Token) em Seller Central > Configurações da conta.',
        },
        {
          key: 'marketplaceSiteId',
          label: 'Marketplace ID',
          type: 'text',
          required: true,
          placeholder: 'A2Q3Y263D00KWC',
          helpText: 'ID do marketplace da região (BR/EUA/UE) usado nas chamadas SP-API.',
        },
        {
          key: 'refreshToken',
          label: 'LWA refresh token',
          type: 'password',
          required: true,
          secret: true,
          placeholder: 'Atzr|...',
          helpText:
            'Token de longa duração gerado em Seller Central > Desenvolvedor de apps > Autorizar app.',
        },
        {
          key: 'smtp_sender_email',
          label: 'E-mail remetente aprovado',
          type: 'email',
          required: true,
          placeholder: 'loja@minhamarca.com.br',
          helpText:
            'Remetente verificado em Seller Central. É a rota obrigatória da Buyer-Seller Messaging (Route 1).',
        },
        {
          key: 'inbound_email_route',
          label: 'Rota de e-mail de entrada',
          type: 'email',
          required: true,
          placeholder: 'amazon-relay@inbound.sachub.app',
          helpText: 'Endereço do relay SES que recebe as mensagens do comprador.',
        },
        {
          key: 'approved_sender_domains',
          label: 'Domínios aprovados',
          type: 'text',
          required: false,
          placeholder: 'minhamarca.com.br,outramarca.com.br',
          helpText: 'Domínios que podem aparecer como links nas mensagens (separados por vírgula).',
        },
        {
          key: 'seller_central_region',
          label: 'Região Seller Central',
          type: 'select',
          required: false,
          options: [
            { value: 'na', label: 'América do Norte (na)' },
            { value: 'eu', label: 'Europa (eu)' },
            { value: 'fe', label: 'Extremo Oriente (fe)' },
          ],
        },
      ],
      authorizeUrlTemplate,
      webhookPath: '/webhooks/amazon/ses',
      docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/buyer-seller-messaging',
      notes: [
        'Com AMAZON_APP_ID configurado, "Autorizar na Amazon" usa o OAuth SP-API e dispensa colar o refresh token.',
        'A Amazon exige que a primeira resposta ao comprador use o relay SMTP aprovado (Route 1); nunca envie e-mail direto por SES.',
        'Mensagens proativas só são permitidas dentro da janela de 24h da Buyer-Seller Messaging e passam por getMessagingActionsForOrder.',
        'Dados restritos do comprador exigem RDT e são expurgados 30 dias após o envio (buyer_pii_vault).',
        'Opt-out do comprador exige o prefixo [Important] em mensagens críticas.',
        'Nenhum polling de IMAP: o relay SES entrega o .eml bruto por HTTP assinado (x-sac-signature).',
      ],
    };
  }

  private describeMeli(): ConnectorDescriptor {
    return {
      marketplace: 'MERCADO_LIVRE',
      authMode: 'OAUTH2',
      fields: [
        {
          key: 'displayName',
          label: 'Nome da loja',
          type: 'text',
          required: true,
          placeholder: 'Mercado Livre - Loja Principal',
        },
        {
          key: 'clientId',
          label: 'Client ID',
          type: 'text',
          required: true,
          placeholder: '1234567890',
          helpText: 'App criado em developers.mercadolivre.com.br.',
        },
        {
          key: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          required: true,
          secret: true,
          helpText: 'Credencial secreta do app Meli (armazenada apenas no servidor).',
        },
        {
          key: 'redirectUri',
          label: 'Redirect URI',
          type: 'url',
          required: true,
          placeholder: this.config.meli.redirectUri,
          helpText: 'Deve ser exatamente a URL cadastrada no app do Mercado Livre.',
        },
        {
          key: 'sellerId',
          label: 'Seller ID',
          type: 'text',
          required: true,
          placeholder: '123456789',
          helpText: 'ID do vendedor (user_id). O callback OAuth também resolve automaticamente.',
        },
      ],
      authorizeUrlTemplate: `${MELI_AUTHORIZE_URL}?response_type=code&client_id=<clientId>&redirect_uri=<redirectUri>&state=<state>`,
      webhookPath: '/webhooks/mercadolivre',
      docsUrl: 'https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao',
      notes: [
        'O refresh token do Meli rotaciona: o SAC Hub renova a cada ~5h45m sob lock distribuído.',
        'Webhooks do Meli não têm assinatura criptográfica; a conta é resolvida pelo user_id do payload.',
        'Claims de pós-venda trazem due_date real e bloqueiam o chat do pack: use as ações do cockpit.',
        'O callback devolve o navegador para a tela de contas com ?connected=mercadolivre.',
      ],
    };
  }

  private describeShopee(): ConnectorDescriptor {
    return {
      marketplace: 'SHOPEE',
      authMode: 'OAUTH2',
      fields: [
        {
          key: 'displayName',
          label: 'Nome da loja',
          type: 'text',
          required: true,
          placeholder: 'Shopee - Loja Principal',
        },
        {
          key: 'partnerId',
          label: 'Partner ID',
          type: 'text',
          required: true,
          placeholder: '1000000',
          helpText: 'Partner ID do app em open.shopee.com.',
        },
        {
          key: 'partnerKey',
          label: 'Partner Key',
          type: 'password',
          required: true,
          secret: true,
          helpText: 'Chave usada para assinar 100% das chamadas e validar webhooks.',
        },
        {
          key: 'redirectUri',
          label: 'Redirect URI',
          type: 'url',
          required: true,
          placeholder: this.config.shopee.redirectUri,
          helpText: 'URL de callback cadastrada no Open Platform.',
        },
        {
          key: 'shopId',
          label: 'Shop ID',
          type: 'text',
          required: true,
          placeholder: '123456789',
          helpText: 'ID da loja Shopee que autorizou o app.',
        },
      ],
      authorizeUrlTemplate: `${this.config.shopee.apiBase}/api/v2/shop/auth_partner?partner_id=<partnerId>&redirect=<redirectUri>&timestamp=<timestamp>&sign=<sign>`,
      webhookPath: '/webhooks/shopee',
      docsUrl: 'https://open.shopee.com/documents/v2/v2.shop.auth_partner?module=95&type=1',
      notes: [
        'O refresh token da Shopee é de uso único: a renovação é serializada por Redlock e roda a cada 3h30m.',
        'Webhooks são validados com HMAC-SHA256(webhookUrl + "|" + rawBody) usando a Partner Key.',
        'O CRR (Chat Response Rate) de 12h exige que a última mensagem seja sempre do vendedor.',
        'Lost pushes são recuperados por v2.push.get_lost_push_message a cada 5 minutos.',
        'Shop IDs desconhecidos são recusados para não criar tickets na loja errada.',
      ],
    };
  }

  /* ==================================================================== */
  /* OAuth start                                                          */
  /* ==================================================================== */

  async startOAuth(marketplace: Marketplace, displayName: string, tenantId?: string | null): Promise<OAuthStartResult> {
    const trimmedName = (displayName ?? '').trim();
    if (trimmedName === '') {
      throw new ValidationError('displayName is required to start the OAuth flow');
    }

    if (marketplace === 'AMAZON') {
      // Fail before writing the state: an unconfigured app must not create a
      // consent URL that Amazon will reject.
      this.assertAmazonOAuthConfigured(['AMAZON_APP_ID']);
    }

    const payload: OAuthStatePayload = {
      tenantId: tenantId ?? null,
      marketplace,
      displayName: trimmedName,
      nonce: randomBytes(24).toString('hex'),
      issuedAt: this.clock.now().getTime(),
    };
    const state = this.signState(payload);
    await this.cache.set(`${OAUTH_STATE_CACHE_PREFIX}${payload.nonce}`, payload, OAUTH_STATE_TTL_SECONDS);

    const authorizeUrl =
      marketplace === 'AMAZON'
        ? this.buildAmazonAuthorizeUrl(state)
        : marketplace === 'MERCADO_LIVRE'
          ? this.buildMeliAuthorizeUrl(state)
          : this.buildShopeeAuthorizeUrl(state);

    return { authorizeUrl, state, marketplace };
  }

  private signState(payload: OAuthStatePayload): string {
    const signature = this.stateSignature(payload);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${signature}`;
  }

  private stateSignature(payload: OAuthStatePayload): string {
    return this.cipher.hash(
      `${payload.marketplace}|${payload.displayName}|${payload.nonce}|${payload.issuedAt}|${payload.tenantId ?? ''}`,
    );
  }

  private buildMeliAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.meli.clientId,
      redirect_uri: this.config.meli.redirectUri,
      state,
    });
    return `${MELI_AUTHORIZE_URL}?${params.toString()}`;
  }

  private buildShopeeAuthorizeUrl(state: string): string {
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = this.shopeeSign(path, timestamp);
    const params = new URLSearchParams({
      partner_id: String(this.config.shopee.partnerId),
      redirect: this.config.shopee.redirectUri,
      timestamp: String(timestamp),
      sign,
      state,
    });
    return `${this.config.shopee.apiBase}/api/v2/shop/auth_partner?${params.toString()}`;
  }

  /**
   * Seller Central consent URL (SP-API OAuth).
   *
   * `version=beta` is the value Amazon documents for the self-service consent
   * screen; `state` is the same signed, single-use token used by Meli/Shopee.
   */
  private buildAmazonAuthorizeUrl(state: string): string {
    const base = (
      this.config.amazon.oauthAuthorizeUrl ?? DEFAULT_AMAZON_AUTHORIZE_URL
    ).replace(/\/+$/, '');
    const params = new URLSearchParams({
      application_id: this.config.amazon.appId ?? '',
      state,
      version: 'beta',
    });
    return `${base}?${params.toString()}`;
  }

  /**
   * Fails with `AMAZON_OAUTH_NOT_CONFIGURED` (409) plus the exact missing
   * variables, so the UI can render remediation instead of a generic 500.
   */
  private assertAmazonOAuthConfigured(required: readonly string[]): void {
    const values: Record<string, string | undefined> = {
      AMAZON_APP_ID: this.config.amazon.appId,
      AMAZON_LWA_CLIENT_ID: this.config.amazon.lwaClientId,
      AMAZON_LWA_CLIENT_SECRET: this.config.amazon.lwaClientSecret,
      AMAZON_APP_REDIRECT_URI: this.config.amazon.appRedirectUri,
    };

    const missing = required.filter((key) => readString(values[key]) === null);
    if (missing.length > 0) {
      throw new AmazonOAuthNotConfiguredError(missing, AMAZON_OAUTH_NOT_CONFIGURED_REMEDIATION);
    }
  }

  /* ==================================================================== */
  /* OAuth callback                                                       */
  /* ==================================================================== */

  async completeOAuth(
    marketplace: Marketplace,
    input: OAuthCallbackInput,
  ): Promise<{ accountId: string; displayName: string }> {
    if (!input.code || input.code.trim() === '') {
      throw new ValidationError('Missing authorization code', { marketplace });
    }

    const state = await this.consumeState(input.state, marketplace);

    if (marketplace === 'AMAZON') return this.completeAmazonOAuth(state, input);
    if (marketplace === 'MERCADO_LIVRE') return this.completeMeliOAuth(state, input);
    return this.completeShopeeOAuth(state, input);
  }

  private async consumeState(
    state: string,
    marketplace: Marketplace,
  ): Promise<OAuthStatePayload> {
    const [encoded, signature] = (state ?? '').split('.');
    if (!encoded || !signature) {
      throw new ValidationError('Malformed OAuth state');
    }

    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
    } catch {
      throw new ValidationError('Malformed OAuth state payload');
    }

    if (payload.marketplace !== marketplace) {
      throw new ValidationError('OAuth state does not match the callback marketplace', {
        expected: payload.marketplace,
        received: marketplace,
      });
    }
    if (typeof payload.nonce !== 'string' || typeof payload.issuedAt !== 'number') {
      throw new ValidationError('Malformed OAuth state payload');
    }
    if (this.stateSignature(payload) !== signature) {
      throw new ValidationError('OAuth state signature mismatch');
    }

    const cacheKey = `${OAUTH_STATE_CACHE_PREFIX}${payload.nonce}`;
    const cached = await this.cache.get<OAuthStatePayload>(cacheKey);
    if (!cached || cached.nonce !== payload.nonce) {
      throw new ValidationError('OAuth state expired or already used; restart the connection');
    }
    const ageMs = this.clock.now().getTime() - payload.issuedAt;
    if (ageMs > OAUTH_STATE_TTL_SECONDS * 1000) {
      await this.cache.del(cacheKey);
      throw new ValidationError('OAuth state expired; restart the connection');
    }

    // Single use: burn the state before calling the provider.
    await this.cache.del(cacheKey);
    return payload;
  }

  private async completeMeliOAuth(
    state: OAuthStatePayload,
    input: OAuthCallbackInput,
  ): Promise<{ accountId: string; displayName: string }> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.meli.clientId,
      client_secret: this.config.meli.clientSecret,
      code: input.code,
      redirect_uri: this.config.meli.redirectUri,
    });

    const response = await this.http.request<MeliTokenResponse>({
      method: 'POST',
      url: `${this.config.meli.apiBase}/oauth/token`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      timeoutMs: 15_000,
      retries: 1,
    });

    if (!response.ok) {
      throw new MarketplaceApiError(
        'MERCADO_LIVRE',
        response.status,
        'OAuth token exchange failed',
        response.body,
      );
    }

    const accessToken = readString(response.body.access_token);
    const refreshToken = readString(response.body.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new MarketplaceApiError(
        'MERCADO_LIVRE',
        response.status,
        'OAuth token response missing access/refresh token',
        { keys: Object.keys(response.body ?? {}) },
      );
    }

    const externalSellerId =
      readString(response.body.user_id) ?? readString(input.rawQuery.user_id);
    if (!externalSellerId) {
      throw new MarketplaceApiError(
        'MERCADO_LIVRE',
        response.status,
        'OAuth token response missing user_id',
      );
    }

    const expiresIn = Number(response.body.expires_in);
    const tokenExpiresAt = new Date(
      this.clock.now().getTime() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 21_600) * 1000,
    );
    const siteId = await this.fetchMeliSiteId(accessToken, externalSellerId);

    const account = await this.upsertAccount({
      marketplace: 'MERCADO_LIVRE',
      tenantId: state.tenantId ?? null,
      displayName: state.displayName,
      externalSellerId,
      marketplaceSiteId: siteId,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      channelConfig: {
        site_id: siteId,
        auth_flow: 'oauth2',
        mediator_enabled: true,
      },
    });

    this.logger.info('account.oauth.completed', {
      marketplace: 'MERCADO_LIVRE',
      accountId: account.accountId,
      siteId,
    });
    return account;
  }

  private async fetchMeliSiteId(accessToken: string, userId: string): Promise<string> {
    try {
      const response = await this.http.request<MeliUserResponse>({
        method: 'GET',
        url: `${this.config.meli.apiBase}/users/${encodeURIComponent(userId)}`,
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        timeoutMs: 10_000,
        retries: 1,
      });
      const site = readString(response.body?.site_id);
      if (site) return site;
    } catch (error) {
      this.logger.warn('account.meli.site_lookup_failed', {
        error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
      });
    }
    return DEFAULT_SITE_ID;
  }

  private async completeShopeeOAuth(
    state: OAuthStatePayload,
    input: OAuthCallbackInput,
  ): Promise<{ accountId: string; displayName: string }> {
    const shopId = readString(input.shopId) ?? readString(input.rawQuery.shop_id);
    if (!shopId) {
      throw new ValidationError('Shopee callback is missing shop_id');
    }

    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const path = '/api/v2/auth/token/get';
    const sign = this.shopeeSign(path, timestamp);
    const params = new URLSearchParams({
      partner_id: String(this.config.shopee.partnerId),
      timestamp: String(timestamp),
      sign,
    });

    const response = await this.http.request<ShopeeTokenResponse>({
      method: 'POST',
      url: `${this.config.shopee.apiBase}${path}?${params.toString()}`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: {
        code: input.code,
        shop_id: Number.isFinite(Number(shopId)) ? Number(shopId) : shopId,
        partner_id: this.config.shopee.partnerId,
      },
      timeoutMs: 15_000,
      retries: 1,
    });

    if (!response.ok || readString(response.body.access_token) === null) {
      throw new MarketplaceApiError(
        'SHOPEE',
        response.status,
        `Shopee token exchange failed${response.body?.message ? `: ${response.body.message}` : ''}`,
        response.body,
      );
    }

    const accessToken = readString(response.body.access_token);
    const refreshToken = readString(response.body.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new MarketplaceApiError(
        'SHOPEE',
        response.status,
        'Shopee token response missing access/refresh token',
      );
    }

    const expireIn = Number(response.body.expire_in);
    const tokenExpiresAt = new Date(
      this.clock.now().getTime() + (Number.isFinite(expireIn) && expireIn > 0 ? expireIn : 14_400) * 1000,
    );
    const resolvedShopId = readString(response.body.shop_id) ?? shopId;
    const region = readString(input.rawQuery.region) ?? 'BR';

    const account = await this.upsertAccount({
      tenantId: state.tenantId ?? null,
      marketplace: 'SHOPEE',
      displayName: state.displayName,
      externalSellerId: resolvedShopId,
      marketplaceSiteId: resolvedShopId,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      channelConfig: {
        shop_id: resolvedShopId,
        region,
        crr_target: 12,
        auth_flow: 'oauth2',
      },
    });

    this.logger.info('account.oauth.completed', {
      marketplace: 'SHOPEE',
      accountId: account.accountId,
    });
    return account;
  }

  /**
   * Amazon SP-API OAuth callback.
   *
   * 1. `state` was already validated + burned by `consumeState` (tenantId,
   *    displayName and single use).
   * 2. `spapi_oauth_code` is exchanged for LWA tokens at `AMAZON_LWA_TOKEN_URL`
   *    (grant_type=authorization_code) using the app client id/secret and the
   *    redirect URI registered in Seller Central.
   * 3. The returned `refresh_token` (long-lived) is encrypted and the account is
   *    upserted for the tenant from the state, keyed by `selling_partner_id`.
   */
  private async completeAmazonOAuth(
    state: OAuthStatePayload,
    input: OAuthCallbackInput,
  ): Promise<{ accountId: string; displayName: string }> {
    this.assertAmazonOAuthConfigured([
      'AMAZON_APP_ID',
      'AMAZON_LWA_CLIENT_ID',
      'AMAZON_LWA_CLIENT_SECRET',
      'AMAZON_APP_REDIRECT_URI',
    ]);

    const sellingPartnerId =
      readString(input.sellingPartnerId) ?? readString(input.rawQuery['selling_partner_id']);
    if (!sellingPartnerId) {
      throw new ValidationError('Amazon callback is missing selling_partner_id');
    }

    const redirectUri = readString(this.config.amazon.appRedirectUri);
    if (!redirectUri) {
      // Defensive: `assertAmazonOAuthConfigured` already guarantees this.
      throw new AmazonOAuthNotConfiguredError(
        ['AMAZON_APP_REDIRECT_URI'],
        AMAZON_OAUTH_NOT_CONFIGURED_REMEDIATION,
      );
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: this.config.amazon.lwaClientId,
      client_secret: this.config.amazon.lwaClientSecret,
      redirect_uri: redirectUri,
    });

    const response = await this.http.request<AmazonLwaTokenResponse>({
      method: 'POST',
      url: this.config.amazon.lwaTokenUrl,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      timeoutMs: 15_000,
      retries: 1,
    });

    const refreshToken = readString(response.body?.refresh_token);
    if (!response.ok || refreshToken === null) {
      const reason =
        readString(response.body?.error_description) ??
        readString(response.body?.error) ??
        'no refresh_token returned';
      throw new MarketplaceApiError(
        'AMAZON',
        response.status,
        `LWA authorization-code exchange failed: ${reason}`,
        {
          error: readString(response.body?.error) ?? null,
          keys: Object.keys(response.body ?? {}),
        },
      );
    }

    const accessToken = readString(response.body?.access_token);
    const expiresIn = Number(response.body?.expires_in);
    const tokenExpiresAt = new Date(
      this.clock.now().getTime() +
        (Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn
          : AMAZON_DEFAULT_TOKEN_TTL_SECONDS) *
          1000,
    );
    const region = this.config.amazon.region;

    const account = await this.upsertAccount({
      tenantId: state.tenantId ?? null,
      marketplace: 'AMAZON',
      displayName: state.displayName,
      externalSellerId: sellingPartnerId,
      marketplaceSiteId: sellingPartnerId,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      channelConfig: {
        selling_partner_id: sellingPartnerId,
        seller_id: sellingPartnerId,
        site_id: sellingPartnerId,
        region,
        seller_central_region: region,
        auth_flow: 'oauth2',
      },
    });

    this.logger.info('account.oauth.completed', {
      marketplace: 'AMAZON',
      accountId: account.accountId,
      region,
    });
    return account;
  }

  /* ==================================================================== */
  /* Credential connection (Amazon / manual)                             */
  /* ==================================================================== */

  async connectWithCredentials(
    input: ConnectAccountRequest,
    tenantId?: string | null,
  ): Promise<{ accountId: string; displayName: string }> {
    const displayName = (input.displayName ?? '').trim();
    const externalSellerId = (input.externalSellerId ?? '').trim();
    const marketplaceSiteId = (input.marketplaceSiteId ?? '').trim();

    if (!displayName) throw new ValidationError('displayName is required');
    if (!externalSellerId) throw new ValidationError('externalSellerId is required');
    if (!marketplaceSiteId) throw new ValidationError('marketplaceSiteId is required');

    const refreshToken = readString(input.refreshToken);
    const accessToken = readString(input.accessToken);

    if (input.marketplace === 'AMAZON') {
      if (!refreshToken) {
        throw new ValidationError(
          'Amazon requires the LWA refresh token generated in Seller Central',
        );
      }
      const channelConfig = input.channelConfig ?? {};
      const senderEmail = readString(channelConfig.smtp_sender_email);
      const inboundRoute = readString(channelConfig.inbound_email_route);
      if (!senderEmail) {
        throw new ValidationError('Amazon requires channelConfig.smtp_sender_email');
      }
      if (!inboundRoute) {
        throw new ValidationError('Amazon requires channelConfig.inbound_email_route');
      }
    }

    const channelConfig: Record<string, unknown> = {
      ...(input.channelConfig ?? {}),
      seller_id: externalSellerId,
      site_id: marketplaceSiteId,
    };
    if (input.marketplace === 'AMAZON') {
      channelConfig.seller_central_region =
        readString(channelConfig.seller_central_region) ?? this.config.amazon.region;
      channelConfig.auth_flow = 'lwa_refresh_token';
    }

    const account = await this.upsertAccount({
      tenantId: tenantId ?? null,
      marketplace: input.marketplace,
      displayName,
      externalSellerId,
      marketplaceSiteId,
      accessToken,
      refreshToken,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      channelConfig,
    });

    this.logger.info('account.credentials.connected', {
      marketplace: input.marketplace,
      accountId: account.accountId,
    });
    return account;
  }

  /* ==================================================================== */
  /* Disconnect / refresh                                                 */
  /* ==================================================================== */

  async disconnect(accountId: string): Promise<void> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundError('MarketplaceAccount', accountId);

    await this.accounts.updateTokens(accountId, {
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      authExpiresAt: null,
    });
    await this.accounts.setStatus(accountId, 'DISCONNECTED' as AccountStatus, null);

    this.realtime?.channelHealth({
      marketplace: account.marketplace,
      accountId,
      healthy: false,
      detail: 'Conta desconectada pelo operador.',
      at: this.clock.now().toISOString(),
    });
    this.logger.info('account.disconnected', { accountId, marketplace: account.marketplace });
  }

  async refreshNow(accountId: string): Promise<{ ok: boolean; detail: string }> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundError('MarketplaceAccount', accountId);

    const adapter = this.adapters.get(account.marketplace);
    if (typeof adapter.runMaintenance !== 'function') {
      return {
        ok: false,
        detail: `O adaptador ${MARKETPLACE_LABEL[account.marketplace]} não implementa manutenção periódica.`,
      };
    }

    try {
      const results = await adapter.runMaintenance();
      const failed = results.filter((entry) => !entry.ok);
      const detail =
        results.length === 0
          ? 'Nenhuma tarefa de manutenção executada.'
          : results.map((entry) => `${entry.task}: ${entry.detail}`).join(' | ');

      if (failed.length > 0) {
        await this.accounts.setStatus(
          accountId,
          'TOKEN_EXPIRED' as AccountStatus,
          failed.map((entry) => entry.detail).join('; ').slice(0, 500),
        );
        this.realtime?.channelHealth({
          marketplace: account.marketplace,
          accountId,
          healthy: false,
          detail: detail.slice(0, 300),
          at: this.clock.now().toISOString(),
        });
        return { ok: false, detail };
      }

      await this.accounts.setStatus(accountId, 'ACTIVE' as AccountStatus, null);
      this.realtime?.channelHealth({
        marketplace: account.marketplace,
        accountId,
        healthy: true,
        detail: detail.slice(0, 300),
        at: this.clock.now().toISOString(),
      });
      return { ok: true, detail };
    } catch (error) {
      const message = redactPiiForLogs(error instanceof Error ? error.message : String(error));
      await this.accounts.setStatus(accountId, 'TOKEN_EXPIRED' as AccountStatus, message.slice(0, 500));
      this.realtime?.channelHealth({
        marketplace: account.marketplace,
        accountId,
        healthy: false,
        detail: message.slice(0, 300),
        at: this.clock.now().toISOString(),
      });
      return { ok: false, detail: message };
    }
  }

  /* ==================================================================== */
  /* Persistence helpers                                                  */
  /* ==================================================================== */

  private async upsertAccount(input: {
    tenantId?: string | null;
    marketplace: Marketplace;
    displayName: string;
    externalSellerId: string;
    marketplaceSiteId: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    channelConfig: Record<string, unknown>;
  }): Promise<{ accountId: string; displayName: string }> {
    const existing = await this.accounts.findByExternalSeller(
      input.marketplace,
      input.externalSellerId,
      input.marketplaceSiteId,
    );

    const accessTokenEnc = input.accessToken ? this.cipher.encrypt(input.accessToken) : null;
    const refreshTokenEnc = input.refreshToken ? this.cipher.encrypt(input.refreshToken) : null;
    const now = this.clock.now();

    if (existing) {
      if (existing.tenantId && input.tenantId && existing.tenantId !== input.tenantId) {
        throw new ValidationError('Account already belongs to another tenant');
      }
      // A legacy (tenantless) account reconnected through OAuth adopts the tenant
      // from the signed state; an already-scoped account keeps its tenant.
      const tenantId = existing.tenantId ?? input.tenantId ?? null;
      await this.accounts.updateTokens(existing.id, {
        ...(accessTokenEnc ? { accessTokenEnc } : {}),
        ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
        ...(input.tokenExpiresAt ? { tokenExpiresAt: input.tokenExpiresAt } : {}),
        status: 'ACTIVE' as AccountStatus,
        lastTokenRefreshAt: now,
        lastError: null,
        lastErrorAt: null,
        tenantId,
      });
      const mergedChannelConfig = {
        ...existing.channelConfig,
        ...input.channelConfig,
      };
      await this.accounts.updateChannelConfig(existing.id, mergedChannelConfig);
      await this.accounts.setStatus(existing.id, 'ACTIVE' as AccountStatus, null);
      this.realtime?.channelHealth({
        marketplace: input.marketplace,
        accountId: existing.id,
        healthy: true,
        detail: 'Credenciais atualizadas.',
        at: now.toISOString(),
      });
      return { accountId: existing.id, displayName: existing.displayName };
    }

    // Fase 4: only a NEW store consumes the `max_accounts` quota; reconnecting
    // an existing one (matched above by marketplace + seller + site) is free.
    if (input.tenantId !== null && input.tenantId !== undefined) {
      await this.planLimits?.assertCanAddAccount(input.tenantId);
    }

    const created = await this.accounts.create({
      tenantId: input.tenantId ?? null,
      marketplace: input.marketplace,
      displayName: input.displayName,
      externalSellerId: input.externalSellerId,
      marketplaceSiteId: input.marketplaceSiteId,
      accessTokenEnc,
      refreshTokenEnc,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      authExpiresAt: null,
      channelConfig: input.channelConfig,
      status: 'ACTIVE' as AccountStatus,
    });
    this.realtime?.channelHealth({
      marketplace: input.marketplace,
      accountId: created.id,
      healthy: true,
      detail: 'Conta conectada.',
      at: now.toISOString(),
    });
    return { accountId: created.id, displayName: created.displayName };
  }

  /* ==================================================================== */
  /* Shopee signing                                                       */
  /* ==================================================================== */

  /**
   * `sign = HMAC_SHA256(partner_id + api_path + timestamp + access_token + shop_id,
   * partner_key)` per Shopee Open Platform v2. Public endpoints (auth) omit the
   * access token/shop id, which is why both default to empty strings.
   */
  private shopeeSign(path: string, timestamp: number, accessToken = '', shopId = ''): string {
    const base = `${this.config.shopee.partnerId}${path}${timestamp}${accessToken}${shopId}`;
    return createHmac('sha256', this.config.shopee.partnerKey).update(base).digest('hex');
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Kept for parity with the historical record shape. */
export function accountTokenStatus(account: MarketplaceAccountRecord, now: Date): AccountStatus {
  if (account.status === 'DISCONNECTED') return 'DISCONNECTED';
  if (!account.accessTokenEnc && !account.refreshTokenEnc) return 'TOKEN_EXPIRED';
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) {
    return 'TOKEN_EXPIRED';
  }
  return account.status;
}
