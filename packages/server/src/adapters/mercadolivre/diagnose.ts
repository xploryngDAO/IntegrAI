import {
  MarketplaceApiError,
  redactPiiForLogs,
  type AdapterDependencies,
  type DiagnosisCheck,
  type DiagnosisStatus,
  type ILogger,
  type MarketplaceAccountRecord,
} from '@sac/shared';
import { loadMeliAccount } from './account';
import type { MeliAuth } from './client/MeliAuth';
import type { MeliClient } from './client/MeliClient';
import { asNumber, asString, errorMessage, isRecord, truncateText } from './mappers';
import type { MeliUser } from './types';

/** Optional read-only probe (items search) toggle, per the diagnostics contract. */
const PROBE_ENV = 'MELI_DIAGNOSE_PROBE';
/** A token expiring within 5 minutes is reported as a warning. */
const TOKEN_WARN_SECONDS = 300;
const DETAIL_LIMIT = 300;

const REAUTH_REMEDIATION =
  'Reautorize a loja Mercado Livre em /accounts (refresh token inválido ou expirado).';
const CONFIG_REMEDIATION =
  'Revise MELI_CLIENT_ID, MELI_CLIENT_SECRET e MELI_API_BASE e reconecte a conta em /accounts.';

function isReauthMessage(message: string): boolean {
  return /invalid_grant|invalid_token|refresh token|revoked|reautoriz/i.test(message);
}

function probeEnabled(): boolean {
  return ['true', '1', 'yes'].includes((process.env[PROBE_ENV] ?? '').trim().toLowerCase());
}

function skipped(id: string, label: string, detail: string): DiagnosisCheck {
  return { id, label, status: 'skipped', detail };
}

function failed(
  id: string,
  label: string,
  detail: string,
  remediation: string,
  latencyMs?: number,
): DiagnosisCheck {
  return { id, label, status: 'fail', detail, remediation, ...(latencyMs !== undefined ? { latencyMs } : {}) };
}

interface TokenCheckResult {
  check: DiagnosisCheck;
  tokenOk: boolean;
}

/**
 * Live Mercado Livre diagnostics used by the cockpit and `npm run doctor`.
 *
 * Real calls only: the checks read the persisted app config, ensure a valid
 * access token through the existing rotating-refresh flow (Redlock serialized),
 * then probe `GET /users/me` + `GET /users/{seller_id}`. The optional
 * `GET /users/{id}/items/search` probe is read-only and gated by
 * `MELI_DIAGNOSE_PROBE=true`. No marketplace write is ever performed and no
 * buyer PII is read or logged.
 */
export class MeliDiagnostics {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly auth: MeliAuth,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'diagnose' });
  }

  async run(accountId: string): Promise<DiagnosisCheck[]> {
    const checks: DiagnosisCheck[] = [];

    let account: MarketplaceAccountRecord | null = null;
    let loadError: string | null = null;
    try {
      account = await loadMeliAccount(this.deps, accountId);
    } catch (error) {
      loadError = errorMessage(error);
    }

    checks.push(this.configCheck(account, loadError));
    if (!account) {
      checks.push(
        skipped('meli.token', 'Access token OAuth', 'Conta indisponível; verificação ignorada.'),
        skipped('meli.identity', 'Identidade do vendedor', 'Conta indisponível; verificação ignorada.'),
        skipped('meli.items', 'Leitura de anúncios', 'Conta indisponível; verificação ignorada.'),
      );
      return checks;
    }

    const tokenResult = await this.tokenCheck(account);
    checks.push(tokenResult.check);
    checks.push(await this.identityCheck(account, tokenResult.tokenOk));
    checks.push(await this.itemsCheck(account, tokenResult.tokenOk));

    this.logger.info('meli.diagnose.completed', {
      accountId,
      statuses: checks.map((check) => `${check.id}:${check.status}`),
    });
    return checks;
  }

  /* -------------------------------- Config --------------------------------- */

  private configCheck(account: MarketplaceAccountRecord | null, loadError: string | null): DiagnosisCheck {
    const id = 'meli.config';
    const label = 'Configuração da aplicação Meli';
    if (!account) {
      const detail = `Conta Mercado Livre não carregada: ${redactPiiForLogs(
        truncateText(loadError ?? 'desconhecida', DETAIL_LIMIT),
      )}`;
      return failed(id, label, detail, 'Conecte ou reconecte a loja Mercado Livre em /accounts.');
    }

    const meli = this.deps.config.meli;
    const missing: string[] = [];
    if (!meli.clientId) missing.push('MELI_CLIENT_ID');
    if (!meli.clientSecret) missing.push('MELI_CLIENT_SECRET');
    if (!meli.apiBase) missing.push('MELI_API_BASE');
    if (missing.length > 0) {
      return failed(
        id,
        label,
        `Configuração incompleta: ${missing.join(', ')}`,
        CONFIG_REMEDIATION,
      );
    }
    if (!account.refreshTokenEnc) {
      return failed(
        id,
        label,
        'Conta conectada sem refresh token armazenado (a rotação OAuth é obrigatória no Mercado Livre).',
        REAUTH_REMEDIATION,
      );
    }
    if (!account.externalSellerId) {
      return failed(
        id,
        label,
        'Conta conectada sem seller_id (externalSellerId).',
        'Reconecte a loja informando o seller id correto em /accounts.',
      );
    }

    return {
      id,
      label,
      status: 'ok',
      detail: `Aplicação configurada (apiBase=${meli.apiBase}); seller_id=${account.externalSellerId}, site_id=${
        account.marketplaceSiteId || 'não informado'
      }, refresh token armazenado.`,
    };
  }

  /* --------------------------------- Token ---------------------------------- */

  private async tokenCheck(account: MarketplaceAccountRecord): Promise<TokenCheckResult> {
    const id = 'meli.token';
    const label = 'Access token OAuth';
    const startedAt = Date.now();
    const before = await this.deps.repos.accounts.findById(account.id);

    try {
      await this.auth.getAccessToken(account.id);
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = redactPiiForLogs(
        truncateText(errorMessage(error), DETAIL_LIMIT),
      );
      const reauth = isReauthMessage(message);
      return {
        tokenOk: false,
        check: failed(
          id,
          label,
          `Falha ao obter access token: ${message}`,
          reauth
            ? REAUTH_REMEDIATION
            : 'Verifique MELI_CLIENT_ID/MELI_CLIENT_SECRET e a conectividade com api.mercadolibre.com.',
          latencyMs,
        ),
      };
    }

    const latencyMs = Date.now() - startedAt;
    const after = (await this.deps.repos.accounts.findById(account.id)) ?? account;
    const expiresAt = after.tokenExpiresAt;
    const remainingSeconds = expiresAt
      ? Math.floor((expiresAt.getTime() - Date.now()) / 1000)
      : null;
    const refreshed =
      (before?.lastTokenRefreshAt?.getTime() ?? null) !==
      (after.lastTokenRefreshAt?.getTime() ?? null);

    if (remainingSeconds === null) {
      return {
        tokenOk: true,
        check: {
          id,
          label,
          status: 'warn',
          detail: 'Access token Bearer obtido, mas `tokenExpiresAt` não está persistido.',
          latencyMs,
          remediation: 'Reconecte a conta para persistir a expiração do token.',
        },
      };
    }

    if (remainingSeconds <= TOKEN_WARN_SECONDS) {
      return {
        tokenOk: true,
        check: {
          id,
          label,
          status: 'warn',
          detail: `Access token Bearer válido porém expira em ${remainingSeconds}s (token_type=Bearer).`,
          latencyMs,
          remediation: 'A renovação automática ocorrerá na próxima chamada; se persistir, reautorize a loja.',
        },
      };
    }

    return {
      tokenOk: true,
      check: {
        id,
        label,
        status: 'ok',
        detail: `Access token Bearer válido${refreshed ? ' (renovado nesta verificação)' : ' (cache)'}; expira em ${remainingSeconds}s.`,
        latencyMs,
      },
    };
  }

  /* -------------------------------- Identity -------------------------------- */

  private async identityCheck(
    account: MarketplaceAccountRecord,
    tokenOk: boolean,
  ): Promise<DiagnosisCheck> {
    const id = 'meli.identity';
    const label = 'Identidade do vendedor';
    if (!tokenOk) {
      return skipped(id, label, 'Sem access token válido; verificação de identidade não executada.');
    }

    const startedAt = Date.now();
    try {
      const me = await this.client.get<MeliUser>(account.id, '/users/me');
      const seller = await this.client.get<MeliUser>(
        account.id,
        `/users/${encodeURIComponent(account.externalSellerId)}`,
      );
      const latencyMs = Date.now() - startedAt;

      const authenticatedId = asString(me.id);
      const sellerId = asString(seller.id) ?? account.externalSellerId;
      const nickname = asString(seller.nickname);
      const siteId = asString(seller.site_id);
      const siteStatus = isRecord(seller.status) ? asString(seller.status.site_status) : null;
      const identityMatches =
        authenticatedId !== null && authenticatedId === account.externalSellerId;
      const siteMatches =
        !siteId || !account.marketplaceSiteId || siteId === account.marketplaceSiteId;

      const detailParts = [
        `seller_id=${sellerId}`,
        nickname ? `nickname=${nickname}` : null,
        `site_id=${siteId ?? 'desconhecido'}`,
        `status=${siteStatus ?? asString(seller.user_type) ?? 'desconhecido'}`,
      ].filter((part): part is string => part !== null);

      if (!identityMatches) {
        detailParts.push(
          `token autentica usuário ${authenticatedId ?? 'desconhecido'} mas a conta conectada é ${account.externalSellerId}`,
        );
      }
      if (!siteMatches) {
        detailParts.push(
          `site diverge da conta conectada (${account.marketplaceSiteId})`,
        );
      }

      if (!identityMatches || !siteMatches) {
        return {
          id,
          label,
          status: 'warn',
          detail: detailParts.join('; '),
          latencyMs,
          remediation:
            'Confirme em /accounts que a loja conectada é o mesmo vendedor do token e que o site está correto.',
        };
      }

      return { id, label, status: 'ok', detail: detailParts.join('; '), latencyMs };
    } catch (error) {
      return this.mapApiErrorToCheck(
        id,
        label,
        error,
        Date.now() - startedAt,
        'Falha ao consultar /users/me ou /users/{seller_id}',
        'Verifique a conectividade com api.mercadolibre.com e os escopos de leitura de usuário.',
      );
    }
  }

  /* ---------------------------------- Items --------------------------------- */

  private async itemsCheck(
    account: MarketplaceAccountRecord,
    tokenOk: boolean,
  ): Promise<DiagnosisCheck> {
    const id = 'meli.items';
    const label = 'Leitura de anúncios';
    if (!tokenOk) {
      return skipped(id, label, 'Sem access token válido; probe de anúncios não executado.');
    }
    if (!probeEnabled()) {
      return skipped(
        id,
        label,
        `Probe desativado (defina ${PROBE_ENV}=true para executar GET /users/{seller_id}/items/search?search_type=scan&limit=1).`,
      );
    }

    const startedAt = Date.now();
    try {
      const response = await this.client.get<unknown>(
        account.id,
        `/users/${encodeURIComponent(account.externalSellerId)}/items/search`,
        { search_type: 'scan', limit: 1 },
      );
      const latencyMs = Date.now() - startedAt;
      const record = isRecord(response) ? response : {};
      const results = Array.isArray(record.results) ? record.results : null;
      const paging = isRecord(record.paging) ? record.paging : null;
      const total = paging ? asNumber(paging.total) : null;

      if (results === null) {
        return {
          id,
          label,
          status: 'warn',
          detail: 'Resposta do items/search sem campo `results`.',
          latencyMs,
          remediation: 'Verifique os escopos de leitura de anúncios da aplicação Meli.',
        };
      }
      if (results.length === 0) {
        return {
          id,
          label,
          status: 'warn',
          detail: `Leitura autenticada ok, porém a loja não retornou anúncios (total=${total ?? 0}).`,
          latencyMs,
          remediation: 'Confirme se o seller possui anúncios ativos.',
        };
      }
      return {
        id,
        label,
        status: 'ok',
        detail: `Leitura de anúncios ok (${results.length} item(ns), total=${total ?? 'desconhecido'}).`,
        latencyMs,
      };
    } catch (error) {
      return this.mapApiErrorToCheck(
        id,
        label,
        error,
        Date.now() - startedAt,
        'Falha ao consultar /users/{seller_id}/items/search',
        'Verifique os escopos de leitura de anúncios e a conectividade.',
      );
    }
  }

  /* -------------------------------- Error map ------------------------------- */

  private mapApiErrorToCheck(
    id: string,
    label: string,
    error: unknown,
    latencyMs: number,
    prefix: string,
    fallbackRemediation: string,
  ): DiagnosisCheck {
    const message = redactPiiForLogs(truncateText(errorMessage(error), DETAIL_LIMIT));
    const status = error instanceof MarketplaceApiError ? error.status : 0;
    const reauth = status === 401 || isReauthMessage(message);
    const transient = status === 429 || status >= 500;

    let checkStatus: DiagnosisStatus = 'fail';
    if (status === 403) checkStatus = 'warn';
    else if (transient) checkStatus = 'warn';

    const remediation = reauth
      ? REAUTH_REMEDIATION
      : status === 403
        ? 'Adicione os escopos necessários à aplicação Meli e reconecte a loja em /accounts.'
        : transient
          ? 'Instabilidade/limite do Mercado Livre: tente novamente em alguns minutos.'
          : fallbackRemediation;

    return {
      id,
      label,
      status: checkStatus,
      detail: `${prefix}: ${message}`,
      latencyMs,
      remediation,
    };
  }
}
