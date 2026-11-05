import {
  MarketplaceApiError,
  TokenRefreshError,
  redactPiiForLogs,
  type AdapterDependencies,
  type DiagnosisCheck,
  type ILogger,
  type MarketplaceAccountRecord,
} from '@sac/shared';
import { ShopeeClient, shopeeErrorCode } from './client/ShopeeClient';
import { ShopeeAuth, loadShopeeAccount } from './client/ShopeeAuth';
import { computeSign } from './client/sign';
import { SHOPEE_API_PATHS, type ShopeeCallResult } from './types';
import { asRecord, pickArray, pickString } from './mappers';

/**
 * Live Shopee diagnostics (`IMarketplaceChannelAdapter.diagnose`).
 *
 * Runs only REAL calls:
 *  - validates the local partner configuration and the HMAC formula;
 *  - guarantees an access token through the existing Redlock refresh path;
 *  - performs a signed `GET /api/v2/shop/get_shop_info` (official method) with
 *    `partner_id`, `timestamp`, `access_token`, `shop_id`, `sign`;
 *  - derives the clock skew from the authoritative HTTP `Date` header of that
 *    call (Shopee rejects timestamps outside ±300 s);
 *  - optionally (SHOPEE_DIAGNOSE_LOST_PUSH=true) performs a signed
 *    `GET /api/v2/push/get_lost_push_message` without consuming the batches.
 *
 * It never writes to buyer chats and never simulates success. The only possible
 * write is the single-use refresh-token rotation required to obtain a valid
 * token (it happens inside the adapter's existing lock, exactly like a normal
 * API call would).
 */

const SANDBOX_HOST = 'partner.test-stable.shopeemobile.com';
const PRODUCTION_HOST = 'partner.shopeemobile.com';
/** Official production hosts (Global / Brazil / Chinese mainland). */
const PRODUCTION_HOSTS = new Set([
  PRODUCTION_HOST,
  'openplatform.shopee.com.br',
  'openplatform.shopee.cn',
]);
const CLOCK_TOLERANCE_SECONDS = 300;
const LOST_PUSH_ENABLED_ENV = 'SHOPEE_DIAGNOSE_LOST_PUSH';

/**
 * Deterministic self-check vector for the signing formula. It uses a throwaway
 * key, so it proves the byte order without touching real credentials.
 */
const SIGNATURE_VECTOR = {
  partnerId: '1',
  apiPath: '/api/v2/x',
  timestamp: 1_700_000_000,
  partnerKey: 'k',
  expected: '51c6ea2ce48cf9c29808cb34d9427c94a3656af4d9da5827c911a05b52908fc0',
} as const;

interface TokenProbe {
  check: DiagnosisCheck;
  hasToken: boolean;
}

interface ShopInfoProbe {
  check: DiagnosisCheck;
  headers: Record<string, string>;
  localStartedMs: number | null;
  callOk: boolean;
}

export class ShopeeDiagnostics {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly auth: ShopeeAuth;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient, auth: ShopeeAuth) {
    this.deps = deps;
    this.client = client;
    this.auth = auth;
    this.logger = deps.logger.child({ component: 'shopee.diagnostics' });
  }

  async diagnose(input: { accountId: string }): Promise<DiagnosisCheck[]> {
    const configCheck = this.configCheck();
    const signCheck = this.signCheck();
    const sandboxCheck = this.sandboxCheck();

    let account: MarketplaceAccountRecord | null = null;
    let accountError: string | null = null;
    try {
      account = await loadShopeeAccount(this.deps, input.accountId);
    } catch (error) {
      accountError = this.describeError(error);
    }

    if (!account) {
      return [
        configCheck,
        {
          id: 'shopee.clock',
          label: 'Clock skew (< 300s)',
          status: 'skipped',
          detail: 'Conta indisponível; não houve chamada autenticada para medir o desvio de relógio.',
          remediation: 'Corrija o problema da conta (shopee.config/shopee.token) e rode o diagnóstico novamente.',
        },
        {
          id: 'shopee.token',
          label: 'Access token',
          status: 'fail',
          detail: accountError ?? 'Conta Shopee não encontrada.',
          remediation: 'Verifique se a conta existe e está conectada (wizard "Conectar loja").',
        },
        signCheck,
        {
          id: 'shopee.shop_info',
          label: 'Loja (get_shop_info)',
          status: 'skipped',
          detail: 'Sem token válido para chamar /api/v2/shop/get_shop_info.',
          remediation: 'Resolva o check shopee.token primeiro.',
        },
        {
          id: 'shopee.lost_push',
          label: 'Lost push recovery',
          status: 'skipped',
          detail: 'Requer autenticação válida.',
          remediation: 'Resolva o check shopee.token primeiro.',
        },
        sandboxCheck,
      ];
    }

    const token = await this.tokenCheck(account);
    const shopInfo = await this.shopInfoCheck(account, token.hasToken && token.check.status === 'ok');
    const clockCheck = this.clockCheck(shopInfo);
    // The lost-push endpoint is public (partner-signed): it does not depend on the
    // store access token, so it can still be validated when the token is broken.
    const lostPushCheck = await this.lostPushCheck();

    return [configCheck, clockCheck, token.check, signCheck, shopInfo.check, lostPushCheck, sandboxCheck];
  }

  /* ====================================================================== */
  /* Local checks (no network)                                              */
  /* ====================================================================== */

  private configCheck(): DiagnosisCheck {
    const config = this.deps.config.shopee;
    const apiBase = (config.apiBase ?? '').trim();
    const host = extractHost(apiBase);
    const issues: string[] = [];

    if (!String(config.partnerId ?? '').trim()) issues.push('SHOPEE_PARTNER_ID ausente');
    if (!(config.partnerKey ?? '').trim()) issues.push('SHOPEE_PARTNER_KEY ausente');
    if (!(config.redirectUri ?? '').trim()) issues.push('SHOPEE_REDIRECT_URI ausente');
    const apiBaseProblem = validateApiBase(apiBase);
    if (apiBaseProblem) issues.push(apiBaseProblem);

    const sandbox = isSandboxHost(host);
    if (issues.length > 0) {
      return {
        id: 'shopee.config',
        label: 'Configuração do parceiro Shopee',
        status: 'fail',
        detail: issues.join('; '),
        remediation:
          'Defina SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_REDIRECT_URI e SHOPEE_API_BASE no .env e reinicie a API.',
      };
    }

    return {
      id: 'shopee.config',
      label: 'Configuração do parceiro Shopee',
      status: 'ok',
      detail:
        `partner_id=${String(config.partnerId)}, partner_key=configurada, ` +
        `api_base=${host || apiBase}${sandbox ? ' (sandbox)' : ''}, refresh_interval=${config.refreshIntervalSeconds}s`,
    };
  }

  private signCheck(): DiagnosisCheck {
    const startedAt = Date.now();
    try {
      const actual = computeSign({
        partnerId: SIGNATURE_VECTOR.partnerId,
        apiPath: SIGNATURE_VECTOR.apiPath,
        timestamp: SIGNATURE_VECTOR.timestamp,
        partnerKey: SIGNATURE_VECTOR.partnerKey,
      });
      const ok = actual === SIGNATURE_VECTOR.expected;
      return {
        id: 'shopee.sign',
        label: 'Assinatura HMAC-SHA256',
        status: ok ? 'ok' : 'fail',
        detail: ok
          ? 'Fórmula validada com vetor determinístico: HMAC-SHA256(partner_id + api_path + timestamp + access_token + shop_id, partner_key) em hex minúsculo.'
          : `Fórmula divergente: esperado ${SIGNATURE_VECTOR.expected.slice(0, 12)}…, obtido ${actual.slice(0, 12)}….`,
        latencyMs: Date.now() - startedAt,
        ...(ok
          ? {}
          : {
              remediation:
                'Atualize o adaptador: o sign deve ser HMAC-SHA256(partner_id + apiPath + timestamp + access_token + shop_id) com partner_key, hex minúsculo, e apiPath sem scheme/host/query.',
            }),
      };
    } catch (error) {
      return {
        id: 'shopee.sign',
        label: 'Assinatura HMAC-SHA256',
        status: 'fail',
        detail: `Falha ao calcular a assinatura local: ${this.describeError(error)}`,
        latencyMs: Date.now() - startedAt,
        remediation: 'Verifique a implementação de computeSign no adaptador Shopee.',
      };
    }
  }

  private sandboxCheck(): DiagnosisCheck {
    const apiBase = (this.deps.config.shopee.apiBase ?? '').trim();
    const host = extractHost(apiBase);

    if (isSandboxHost(host)) {
      return {
        id: 'shopee.sandbox',
        label: 'Ambiente Shopee',
        status: 'warn',
        detail: `Sandbox ativo (${host}): chamadas reais, porém contra o ambiente de testes da Shopee.`,
        remediation:
          'Para operar lojas reais, defina SHOPEE_API_BASE=https://partner.shopeemobile.com (ou https://openplatform.shopee.com.br para lojas BR) e reinicie a API.',
      };
    }
    if (isProductionHost(host)) {
      return {
        id: 'shopee.sandbox',
        label: 'Ambiente Shopee',
        status: 'ok',
        detail: `Produção (${host}).`,
      };
    }
    return {
      id: 'shopee.sandbox',
      label: 'Ambiente Shopee',
      status: 'warn',
      detail: `SHOPEE_API_BASE customizada: ${host || apiBase || '(vazia)'}.`,
      remediation:
        'Use https://partner.shopeemobile.com ou https://openplatform.shopee.com.br (produção) ou https://openplatform.sandbox.test-stable.shopee.sg / https://partner.test-stable.shopeemobile.com (sandbox).',
    };
  }

  /* ====================================================================== */
  /* Live checks                                                            */
  /* ====================================================================== */

  private async tokenCheck(account: MarketplaceAccountRecord): Promise<TokenProbe> {
    const startedAt = Date.now();
    try {
      // Uses the cached access token or rotates the single-use refresh token
      // inside CACHE_KEYS.shopeeRefreshLock (same lock as maintenance).
      const credentials = await this.auth.getCredentials(account.id);
      const expiresAt = account.tokenExpiresAt?.toISOString() ?? 'desconhecido';
      return {
        check: {
          id: 'shopee.token',
          label: 'Access token',
          status: 'ok',
          detail: `Token válido para a loja ${credentials.shopId} (expira em ${expiresAt}).`,
          latencyMs: Date.now() - startedAt,
        },
        hasToken: true,
      };
    } catch (error) {
      const code = shopeeErrorCode(error);
      const message = this.describeError(error);
      const invalidRefresh =
        error instanceof TokenRefreshError || code === 'invalid_refresh_token';
      this.logger.warn('shopee.diagnose.token_failed', {
        accountId: account.id,
        errorCode: code,
        error: message,
      });
      return {
        check: {
          id: 'shopee.token',
          label: 'Access token',
          status: 'fail',
          detail: `${code ? `${code}: ` : ''}${message}`,
          latencyMs: Date.now() - startedAt,
          remediation: invalidRefresh
            ? 'O refresh token expirou/foi invalidado (single-use). Reconecte a loja pelo wizard "Conectar loja" (OAuth Shopee).'
            : 'Verifique SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY e a conectividade; depois rode POST /accounts/:id/refresh.',
        },
        hasToken: false,
      };
    }
  }

  private async shopInfoCheck(
    account: MarketplaceAccountRecord,
    canCall: boolean,
  ): Promise<ShopInfoProbe> {
    if (!canCall) {
      return {
        check: {
          id: 'shopee.shop_info',
          label: 'Loja (get_shop_info)',
          status: 'skipped',
          detail: 'Pulado: o access token não está válido.',
          remediation: 'Resolva o check shopee.token primeiro.',
        },
        headers: {},
        localStartedMs: null,
        callOk: false,
      };
    }

    const startedAt = Date.now();
    const localStartedMs = this.deps.clock.now().getTime();
    try {
      const result = await this.fetchShopInfo(account);
      const data = asRecord(result.data) ?? {};
      const shopName = pickString(data, ['shop_name', 'shopName']) ?? '(sem nome)';
      const shopStatus = pickString(data, ['status', 'shop_status']) ?? 'desconhecido';
      const region = pickString(data, ['region']) ?? 'n/a';
      const healthy = isHealthyShopStatus(shopStatus);

      return {
        check: {
          id: 'shopee.shop_info',
          label: 'Loja (get_shop_info)',
          status: healthy ? 'ok' : 'warn',
          detail:
            `Loja "${shopName}" | região ${region} | status ${shopStatus}` +
            (result.requestId ? ` | request_id ${result.requestId}` : ''),
          latencyMs: Date.now() - startedAt,
          ...(healthy
            ? {}
            : {
                remediation:
                  'Verifique o status da loja no Seller Centre / open.shopee.com; lojas suspensas ou congeladas não podem enviar mensagens.',
              }),
        },
        headers: result.headers,
        localStartedMs,
        callOk: true,
      };
    } catch (error) {
      const code = shopeeErrorCode(error);
      const message = this.describeError(error);
      const requestId = this.requestIdOf(error);
      this.logger.warn('shopee.diagnose.shop_info_failed', {
        accountId: account.id,
        errorCode: code,
        requestId,
        error: message,
      });
      return {
        check: {
          id: 'shopee.shop_info',
          label: 'Loja (get_shop_info)',
          status: 'fail',
          detail:
            `${code ? `${code}: ` : ''}${message}` + (requestId ? ` (request_id ${requestId})` : ''),
          latencyMs: Date.now() - startedAt,
          remediation: this.remediationForApiError(code, message),
        },
        headers: {},
        localStartedMs,
        callOk: false,
      };
    }
  }

  private clockCheck(shopInfo: ShopInfoProbe): DiagnosisCheck {
    if (shopInfo.localStartedMs === null || !shopInfo.callOk) {
      return {
        id: 'shopee.clock',
        label: 'Clock skew (< 300s)',
        status: 'skipped',
        detail: 'Sem resposta autenticada bem-sucedida da Shopee para medir o desvio de relógio.',
        remediation: 'Resolva o check shopee.shop_info primeiro.',
      };
    }

    const dateHeader = shopInfo.headers['date'] ?? shopInfo.headers['Date'];
    const serverMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
    if (!Number.isFinite(serverMs)) {
      return {
        id: 'shopee.clock',
        label: 'Clock skew (< 300s)',
        status: 'ok',
        detail:
          'Header Date ausente na resposta; a chamada assinada (/shop/get_shop_info) foi aceita, portanto o timestamp está dentro da janela de 5 minutos.',
      };
    }

    const skewSeconds = Math.round((serverMs - shopInfo.localStartedMs) / 1000);
    const absSkew = Math.abs(skewSeconds);
    const withinTolerance = absSkew <= CLOCK_TOLERANCE_SECONDS;
    return {
      id: 'shopee.clock',
      label: 'Clock skew (< 300s)',
      status: withinTolerance ? 'ok' : 'fail',
      detail: `Desvio de ${skewSeconds}s entre o relógio local e o servidor Shopee (limite ±${CLOCK_TOLERANCE_SECONDS}s).`,
      ...(withinTolerance
        ? {}
        : {
            remediation:
              'Sincronize o relógio do servidor (NTP/chrony) e reinicie os workers; a Shopee rejeita chamadas com timestamp fora de ±5 minutos.',
          }),
    };
  }

  /**
   * Official v2 contract: `GET /api/v2/shop/get_shop_info` with
   * `partner_id`, `timestamp`, `access_token`, `shop_id`, `sign`. Some regional
   * gateways only answer POST for this endpoint, so a 404/405 retries with POST.
   */
  private async fetchShopInfo(
    account: MarketplaceAccountRecord,
  ): Promise<ShopeeCallResult<Record<string, unknown>>> {
    try {
      return await this.client.request<Record<string, unknown>>({
        accountId: account.id,
        apiPath: SHOPEE_API_PATHS.getShopInfo,
        method: 'GET',
      });
    } catch (error) {
      if (error instanceof MarketplaceApiError && (error.status === 404 || error.status === 405)) {
        this.logger.warn('Shopee get_shop_info rejected GET; retrying with POST (compatibilidade)', {
          accountId: account.id,
        });
        return this.client.request<Record<string, unknown>>({
          accountId: account.id,
          apiPath: SHOPEE_API_PATHS.getShopInfo,
          method: 'POST',
        });
      }
      throw error;
    }
  }

  private async lostPushCheck(): Promise<DiagnosisCheck> {
    const enabled = (process.env[LOST_PUSH_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
    if (!enabled) {
      return {
        id: 'shopee.lost_push',
        label: 'Lost push recovery',
        status: 'skipped',
        detail: `Check opcional desabilitado. Defina ${LOST_PUSH_ENABLED_ENV}=true para consultar pushes perdidos (somente leitura).`,
      };
    }

    const startedAt = Date.now();
    try {
      const result = await this.client.publicRequest<Record<string, unknown>>({
        // Official v2: GET, PUBLIC (partner_id/timestamp/sign only), no params.
        apiPath: SHOPEE_API_PATHS.getLostPushMessage,
        method: 'GET',
      });
      const data = asRecord(result.data) ?? {};
      const pending = pickArray(data, ['push_message_list', 'data', 'lost_push_message_list']);
      const hasNextPage = data['has_next_page'] === true;
      return {
        id: 'shopee.lost_push',
        label: 'Lost push recovery',
        status: 'ok',
        detail:
          `${pending.length} push(es) perdido(s) pendente(s)` +
          `${hasNextPage ? ' (has_next_page=true)' : ''}; nenhum lote foi consumido/confirmado pelo diagnóstico.`,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const code = shopeeErrorCode(error);
      const message = this.describeError(error);
      const requestId = this.requestIdOf(error);
      this.logger.warn('shopee.diagnose.lost_push_failed', {
        errorCode: code,
        requestId,
        error: message,
      });
      return {
        id: 'shopee.lost_push',
        label: 'Lost push recovery',
        status: 'fail',
        detail:
          `${code ? `${code}: ` : ''}${message}` + (requestId ? ` (request_id ${requestId})` : ''),
        latencyMs: Date.now() - startedAt,
        remediation:
          'Verifique os escopos de push do app em open.shopee.com e a conectividade; nenhum dado foi consumido.',
      };
    }
  }

  /* ====================================================================== */
  /* Helpers                                                                */
  /* ====================================================================== */

  private requestIdOf(error: unknown): string | null {
    if (!(error instanceof MarketplaceApiError)) return null;
    const payload = asRecord(error.payload);
    const fromPayload = pickString(payload, ['request_id', 'requestId']);
    if (fromPayload) return fromPayload;
    const details = error.details;
    if (!details) return null;
    const value = details['request_id'];
    return typeof value === 'string' ? value : null;
  }

  private remediationForApiError(code: string | null, message: string): string {
    if (
      code === 'invalid_refresh_token' ||
      code === 'invalid_acceess_token' ||
      code === 'invalid_access_token' ||
      code === 'error_auth'
    ) {
      return 'Reconecte a loja pelo wizard "Conectar loja" (OAuth Shopee) e confirme SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY.';
    }
    if (code === 'error_sign') {
      return 'Assinatura rejeitada pela Shopee: confira SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY (partner key do app).';
    }
    if (code === 'error_param') {
      return 'A Shopee rejeitou parâmetros: verifique os escopos/permissões do app e a versão do adaptador.';
    }
    if (/timeout|network|fetch failed|econn|enotfound|socket/i.test(message)) {
      return 'Falha de rede/timeout: verifique a conectividade de saída da API com partner.shopeemobile.com e tente novamente.';
    }
    return 'Verifique o status do app em open.shopee.com, os logs do adaptador e tente novamente.';
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactPiiForLogs(message).slice(0, 400);
  }
}

/* ---------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                      */
/* ---------------------------------------------------------------------- */

export function extractHost(apiBase: string): string {
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isSandboxHost(host: string): boolean {
  return host === SANDBOX_HOST || host.includes('test-stable');
}

export function isProductionHost(host: string): boolean {
  return PRODUCTION_HOSTS.has(host);
}

export function validateApiBase(apiBase: string): string | null {
  const trimmed = (apiBase ?? '').trim();
  if (trimmed.length === 0) return 'SHOPEE_API_BASE ausente';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return 'SHOPEE_API_BASE deve usar https';
    return null;
  } catch {
    return 'SHOPEE_API_BASE inválida (URL absoluta esperada)';
  }
}

export function isHealthyShopStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return normalized === 'NORMAL' || normalized === 'ACTIVE' || normalized === 'OK';
}
