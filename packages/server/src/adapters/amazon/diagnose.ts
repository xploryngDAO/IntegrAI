import {
  AMAZON_ORDER_ID_REGEX,
  AMAZON_RDT_DATA_ELEMENTS,
  redactPiiForLogs,
} from '@sac/shared';
import type {
  AdapterDependencies,
  DiagnosisCheck,
  DiagnosisStatus,
  HttpResponse,
  MarketplaceAccountRecord,
} from '@sac/shared';
import { asRecord, isRecord, readNumber, readString } from './guards';
import type { JsonRecord } from './types';

/**
 * Live Amazon channel diagnostics.
 *
 * This module intentionally performs REAL calls only:
 *  1. `amazon.config`  — local credential/account checks (no network);
 *  2. `amazon.lwa`     — LWA refresh-token exchange against `{lwaTokenUrl}`;
 *  3. `amazon.participations` — `GET /sellers/v1/marketplaceParticipations`
 *     with the LWA token in `x-amz-access-token`;
 *  4. `amazon.rdt`     — `POST /tokens/2021-03-01/restrictedDataToken`, only when
 *     a sample order id is configured (`AMAZON_DIAGNOSE_ORDER_ID` or
 *     `channel_config.diagnose_order_id`). The restricted order itself is never
 *     fetched, so no buyer PII is pulled during a diagnosis.
 *
 * It never writes (no cache/account status/marketplace mutations), never
 * simulates success and never logs tokens or buyer data.
 */

export const AMAZON_DIAGNOSE_ORDER_ID_ENV = 'AMAZON_DIAGNOSE_ORDER_ID';

const PARTICIPATIONS_PATH = '/sellers/v1/marketplaceParticipations';
const RDT_PATH = '/tokens/2021-03-01/restrictedDataToken';
const CHECKPOINT_SKIPPED_DETAIL = 'Ignorado: dependência anterior falhou.';

export async function runAmazonDiagnosis(
  deps: AdapterDependencies,
  accountId: string,
): Promise<DiagnosisCheck[]> {
  const checks: DiagnosisCheck[] = [];

  let account: MarketplaceAccountRecord | null = null;
  try {
    account = await deps.repos.accounts.findById(accountId);
  } catch (error) {
    const message = errorMessage(error);
    checks.push({
      id: 'amazon.config',
      label: 'Configuração da conta Amazon',
      status: 'fail',
      detail: `Não foi possível carregar a conta no banco: ${message}`,
      remediation: 'Verifique a conexão com o banco de dados e tente novamente.',
    });
    checks.push(
      skipCheck('amazon.lwa', 'Troca de token LWA', CHECKPOINT_SKIPPED_DETAIL),
      skipCheck('amazon.participations', 'Marketplaces da conta (Sellers API)', CHECKPOINT_SKIPPED_DETAIL),
      skipCheck('amazon.rdt', 'Restricted Data Token (RDT)', CHECKPOINT_SKIPPED_DETAIL),
    );
    return checks;
  }

  const config = deps.config.amazon;
  const configCheck = buildConfigCheck(deps, account);
  checks.push(configCheck.check);
  if (!configCheck.refreshToken) {
    checks.push(
      skipCheck('amazon.lwa', 'Troca de token LWA', CHECKPOINT_SKIPPED_DETAIL),
      skipCheck('amazon.participations', 'Marketplaces da conta (Sellers API)', CHECKPOINT_SKIPPED_DETAIL),
      skipCheck('amazon.rdt', 'Restricted Data Token (RDT)', CHECKPOINT_SKIPPED_DETAIL),
    );
    logDiagnosis(deps, accountId, checks);
    return checks;
  }

  // ---- amazon.lwa ------------------------------------------------------
  const lwaResult = await checkLwa(deps, config.lwaTokenUrl, {
    clientId: config.lwaClientId,
    clientSecret: config.lwaClientSecret,
    refreshToken: configCheck.refreshToken,
  });
  checks.push(lwaResult.check);

  if (!lwaResult.accessToken) {
    checks.push(
      skipCheck('amazon.participations', 'Marketplaces da conta (Sellers API)', CHECKPOINT_SKIPPED_DETAIL),
      skipCheck('amazon.rdt', 'Restricted Data Token (RDT)', CHECKPOINT_SKIPPED_DETAIL),
    );
    logDiagnosis(deps, accountId, checks);
    return checks;
  }

  // ---- amazon.participations ------------------------------------------
  const participations = await checkParticipations(
    deps,
    config.spApiEndpoint,
    lwaResult.accessToken,
  );
  checks.push(participations.check);

  // ---- amazon.rdt ------------------------------------------------------
  const sampleOrderId = account ? readDiagnoseOrderId(account) : null;
  checks.push(
    await checkRdt(deps, {
      rdtEndpoint: config.rdtEndpoint,
      spApiEndpoint: config.spApiEndpoint,
      accessToken: lwaResult.accessToken,
      orderId: sampleOrderId,
    }),
  );

  logDiagnosis(deps, accountId, checks);
  return checks;
}

/* ==========================================================================
 * Checks
 * ========================================================================== */

function buildConfigCheck(
  deps: AdapterDependencies,
  account: MarketplaceAccountRecord | null,
): { check: DiagnosisCheck; refreshToken: string | null } {
  const config = deps.config.amazon;
  const missing: string[] = [];
  if (!readString(config.lwaClientId)) missing.push('AMAZON_LWA_CLIENT_ID');
  if (!readString(config.lwaClientSecret)) missing.push('AMAZON_LWA_CLIENT_SECRET');
  if (!readString(config.lwaTokenUrl)) missing.push('AMAZON_LWA_TOKEN_URL');
  if (!readString(config.spApiEndpoint)) missing.push('AMAZON_SPAPI_ENDPOINT');
  if (!readString(config.rdtEndpoint)) missing.push('AMAZON_RDT_ENDPOINT');

  if (!account || account.marketplace !== 'AMAZON') {
    return {
      check: {
        id: 'amazon.config',
        label: 'Configuração da conta Amazon',
        status: 'fail',
        detail: 'Conta Amazon não encontrada para o id informado (ou pertence a outro marketplace).',
        remediation:
          'Confira o id da conta e reconecte a integração Amazon em Configurações > Contas.',
      },
      refreshToken: null,
    };
  }

  if (missing.length > 0) {
    return {
      check: {
        id: 'amazon.config',
        label: 'Configuração da conta Amazon',
        status: 'fail',
        detail: `Variáveis de ambiente ausentes: ${missing.join(', ')}.`,
        remediation:
          'Preencha as credenciais LWA/SP-API no .env (AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_LWA_TOKEN_URL, AMAZON_SPAPI_ENDPOINT, AMAZON_RDT_ENDPOINT) e reinicie o servidor.',
      },
      refreshToken: null,
    };
  }

  if (!account.refreshTokenEnc) {
    return {
      check: {
        id: 'amazon.config',
        label: 'Configuração da conta Amazon',
        status: 'fail',
        detail: 'A conta Amazon não possui refresh token LWA armazenado.',
        remediation:
          'Reconecte a conta Amazon informando um refresh token válido gerado no Seller Central (Apps & Services > Develop Apps).',
      },
      refreshToken: null,
    };
  }

  let refreshToken: string;
  try {
    refreshToken = deps.cipher.decrypt(account.refreshTokenEnc);
  } catch (error) {
    const message = redactPiiForLogs(errorMessage(error));
    return {
      check: {
        id: 'amazon.config',
        label: 'Configuração da conta Amazon',
        status: 'fail',
        detail: `Falha ao decifrar o refresh token LWA: ${message}`,
        remediation:
          'Verifique a chave de criptografia (SECRET_ENCRYPTION_KEY) do servidor; se a chave mudou, reconecte a conta Amazon.',
      },
      refreshToken: null,
    };
  }

  if (refreshToken.trim().length === 0) {
    return {
      check: {
        id: 'amazon.config',
        label: 'Configuração da conta Amazon',
        status: 'fail',
        detail: 'Refresh token LWA decifrado está vazio.',
        remediation: 'Reconecte a conta Amazon com um refresh token válido do Seller Central.',
      },
      refreshToken: null,
    };
  }

  return {
    check: {
      id: 'amazon.config',
      label: 'Configuração da conta Amazon',
      status: 'ok',
      detail: `Credenciais LWA/SP-API presentes e refresh token decifrado (status da conta: ${account.status}).`,
    },
    refreshToken,
  };
}

async function checkLwa(
  deps: AdapterDependencies,
  lwaTokenUrl: string,
  credentials: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ check: DiagnosisCheck; accessToken: string | null }> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  }).toString();

  const startedAt = Date.now();
  let response: HttpResponse<JsonRecord> | null = null;
  let transportError: string | null = null;
  try {
    response = await deps.http.request<JsonRecord>({
      method: 'POST',
      url: lwaTokenUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
      timeoutMs: 15_000,
      retries: 1,
    });
  } catch (error) {
    transportError = redactPiiForLogs(errorMessage(error));
  }
  const latencyMs = Date.now() - startedAt;

  if (transportError !== null || !response) {
    return {
      accessToken: null,
      check: {
        id: 'amazon.lwa',
        label: 'Troca de token LWA',
        status: 'warn',
        detail: `Falha de transporte ao chamar o LWA: ${transportError ?? 'sem resposta'}`,
        latencyMs,
        remediation:
          'Verifique egress/proxy/firewall do servidor até api.amazon.com e execute o diagnóstico novamente.',
      },
    };
  }

  const body = asRecord(response.body);
  if (!response.ok || body.error !== undefined) {
    const errorCode = readString(body.error);
    const summary = describeAmazonError(body);
    if (response.ok) {
      return {
        accessToken: null,
        check: {
          id: 'amazon.lwa',
          label: 'Troca de token LWA',
          status: 'fail',
          detail: `LWA respondeu com erro: ${summary}`,
          latencyMs,
          remediation: remediationForLwaError(errorCode),
        },
      };
    }
    const transient = response.status === 429 || response.status >= 500;
    return {
      accessToken: null,
      check: {
        id: 'amazon.lwa',
        label: 'Troca de token LWA',
        status: transient ? 'warn' : 'fail',
        detail: `LWA respondeu HTTP ${response.status}: ${summary}`,
        latencyMs,
        remediation: transient
          ? 'Instabilidade temporária do LWA — tente novamente em alguns minutos.'
          : remediationForLwaError(errorCode),
      },
    };
  }

  const accessToken = readString(body.access_token);
  if (!accessToken) {
    return {
      accessToken: null,
      check: {
        id: 'amazon.lwa',
        label: 'Troca de token LWA',
        status: 'fail',
        detail: 'Resposta HTTP 200 do LWA sem access_token.',
        latencyMs,
        remediation:
          'Resposta inesperada do LWA — verifique se AMAZON_LWA_TOKEN_URL aponta para https://api.amazon.com/auth/o2/token.',
      },
    };
  }

  const expiresIn = readNumber(body.expires_in);
  const tokenType = readString(body.token_type) ?? 'bearer';
  return {
    accessToken,
    check: {
      id: 'amazon.lwa',
      label: 'Troca de token LWA',
      status: 'ok',
      detail: `Access token obtido (${tokenType}${expiresIn ? `, expira em ${expiresIn}s` : ''}).`,
      latencyMs,
    },
  };
}

async function checkParticipations(
  deps: AdapterDependencies,
  spApiEndpoint: string,
  accessToken: string,
): Promise<{ check: DiagnosisCheck }> {
  const url = `${spApiEndpoint.replace(/\/+$/, '')}${PARTICIPATIONS_PATH}`;
  const startedAt = Date.now();
  let response: HttpResponse<JsonRecord> | null = null;
  let transportError: string | null = null;
  try {
    response = await deps.http.request<JsonRecord>({
      method: 'GET',
      url,
      headers: {
        Accept: 'application/json',
        'x-amz-access-token': accessToken,
      },
      timeoutMs: 20_000,
      retries: 1,
    });
  } catch (error) {
    transportError = redactPiiForLogs(errorMessage(error));
  }
  const latencyMs = Date.now() - startedAt;

  if (transportError !== null || !response) {
    return {
      check: {
        id: 'amazon.participations',
        label: 'Marketplaces da conta (Sellers API)',
        status: 'warn',
        detail: `Falha de transporte ao chamar /sellers/v1/marketplaceParticipations: ${
          transportError ?? 'sem resposta'
        }`,
        latencyMs,
        remediation:
          'Verifique egress/DNS até o endpoint SP-API configurado e execute o diagnóstico novamente.',
      },
    };
  }

  if (!response.ok) {
    const summary = describeAmazonError(response.body);
    if (response.status === 401) {
      return {
        check: {
          id: 'amazon.participations',
          label: 'Marketplaces da conta (Sellers API)',
          status: 'fail',
          detail: `Sellers API rejeitou o token (HTTP 401): ${summary}`,
          latencyMs,
          remediation:
            'O access token foi rejeitado — reconecte a conta Amazon e verifique a sincronização de relógio (clock skew).',
        },
      };
    }
    if (response.status === 403) {
      return {
        check: {
          id: 'amazon.participations',
          label: 'Marketplaces da conta (Sellers API)',
          status: 'fail',
          detail: `Acesso negado à Sellers API (HTTP 403): ${summary}`,
          latencyMs,
          remediation:
            'O app não tem a role necessária (Sellers API) ou a autorização foi revogada. Ajuste as roles no Seller Central e reconecte a conta.',
        },
      };
    }
    const transient = response.status === 429 || response.status >= 500;
    return {
      check: {
        id: 'amazon.participations',
        label: 'Marketplaces da conta (Sellers API)',
        status: transient ? 'warn' : 'fail',
        detail: `Sellers API respondeu HTTP ${response.status}: ${summary}`,
        latencyMs,
        remediation: transient
          ? 'Instabilidade temporária do SP-API — tente novamente em alguns minutos.'
          : 'Verifique a configuração do app, as roles e o endpoint SP-API da região.',
      },
    };
  }

  const body = asRecord(response.body);
  const payload = body.payload;
  if (!Array.isArray(payload)) {
    return {
      check: {
        id: 'amazon.participations',
        label: 'Marketplaces da conta (Sellers API)',
        status: 'warn',
        detail: 'Resposta 200 da Sellers API sem a lista `payload` de participações.',
        latencyMs,
        remediation:
          'Confirme se o app tem a role da Sellers API e reautorize a conta no Seller Central.',
      },
    };
  }

  const participations = payload.filter(isRecord).map((entry) => {
    const marketplace = asRecord(entry.marketplace);
    const participation = asRecord(entry.participation);
    return {
      id: readString(marketplace.id) ?? 'desconhecido',
      country: readString(marketplace.countryCode),
      isParticipating: participation.isParticipating === true,
      hasSuspendedListings: participation.hasSuspendedListings === true,
    };
  });

  if (participations.length === 0) {
    return {
      check: {
        id: 'amazon.participations',
        label: 'Marketplaces da conta (Sellers API)',
        status: 'warn',
        detail: 'Nenhum marketplace retornado para a conta.',
        latencyMs,
        remediation:
          'Confira se a conta está ativa e autorizada no Seller Central e se o app possui a role da Sellers API.',
      },
    };
  }

  const summary = participations
    .slice(0, 6)
    .map(
      (item) =>
        `${item.id}${item.country ? ` (${item.country})` : ''} — participando=${
          item.isParticipating ? 'sim' : 'não'
        }, listings_suspensos=${item.hasSuspendedListings ? 'sim' : 'não'}`,
    )
    .join('; ');
  const active = participations.filter((item) => item.isParticipating);
  const anySuspended = participations.some((item) => item.hasSuspendedListings);

  let status: DiagnosisStatus = 'ok';
  if (active.length === 0 || anySuspended) status = 'warn';
  const detail =
    active.length === 0
      ? `Nenhum marketplace com participação ativa. Retornados: ${summary}`
      : `${participations.length} marketplace(s) retornado(s): ${summary}`;

  return {
    check: {
      id: 'amazon.participations',
      label: 'Marketplaces da conta (Sellers API)',
      status,
      detail,
      latencyMs,
      remediation:
        status === 'warn'
          ? 'Há marketplace sem participação ativa ou com listings suspensos — verifique a situação da conta no Seller Central.'
          : undefined,
    },
  };
}

async function checkRdt(
  deps: AdapterDependencies,
  input: {
    rdtEndpoint: string;
    spApiEndpoint: string;
    accessToken: string;
    orderId: string | null;
  },
): Promise<DiagnosisCheck> {
  const orderId = input.orderId;
  if (!orderId) {
    return {
      id: 'amazon.rdt',
      label: 'Restricted Data Token (RDT)',
      status: 'skipped',
      detail:
        'Nenhum order id de amostra configurado; o teste de RDT não foi executado (nenhuma leitura restrita é feita sem order id).',
      remediation:
        'Opcional: defina AMAZON_DIAGNOSE_ORDER_ID (formato 123-4567890-1234567) para validar a emissão de RDT.',
    };
  }

  if (!AMAZON_ORDER_ID_REGEX.test(orderId)) {
    return {
      id: 'amazon.rdt',
      label: 'Restricted Data Token (RDT)',
      status: 'fail',
      detail: 'AMAZON_DIAGNOSE_ORDER_ID não está no formato de order id da Amazon (3-7-7 dígitos).',
      remediation: 'Ajuste AMAZON_DIAGNOSE_ORDER_ID para um pedido válido, ex.: 123-4567890-1234567.',
    };
  }

  const restrictedPath = `/orders/v0/orders/${orderId}`;
  const startedAt = Date.now();
  let response: HttpResponse<JsonRecord> | null = null;
  let transportError: string | null = null;
  try {
    response = await deps.http.request<JsonRecord>({
      method: 'POST',
      url: input.rdtEndpoint,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-amz-access-token': input.accessToken,
      },
      body: {
        restrictedResources: [
          {
            method: 'GET',
            path: restrictedPath,
            dataElements: [...AMAZON_RDT_DATA_ELEMENTS],
          },
        ],
      },
      timeoutMs: 20_000,
      retries: 1,
    });
  } catch (error) {
    transportError = redactPiiForLogs(errorMessage(error));
  }
  const latencyMs = Date.now() - startedAt;

  if (transportError !== null || !response) {
    return {
      id: 'amazon.rdt',
      label: 'Restricted Data Token (RDT)',
      status: 'warn',
      detail: `Falha de transporte ao solicitar RDT: ${transportError ?? 'sem resposta'}`,
      latencyMs,
      remediation:
        'Verifique egress/DNS até o endpoint SP-API configurado e execute o diagnóstico novamente.',
    };
  }

  const body = asRecord(response.body);
  if (!response.ok) {
    const summary = describeAmazonError(body);
    if (response.status === 403) {
      return {
        id: 'amazon.rdt',
        label: 'Restricted Data Token (RDT)',
        status: 'fail',
        detail: `Emissão de RDT negada (HTTP 403): ${summary}`,
        latencyMs,
        remediation:
          'O app não está aprovado para dados restritos (PII). Solicite a aprovação de RDT no Developer Console/Seller Central e reautorize a conta.',
      };
    }
    const transient = response.status === 429 || response.status >= 500;
    if (transient) {
      return {
        id: 'amazon.rdt',
        label: 'Restricted Data Token (RDT)',
        status: 'warn',
        detail: `RDT respondeu HTTP ${response.status}: ${summary}`,
        latencyMs,
        remediation: 'Instabilidade temporária do SP-API — tente novamente em alguns minutos.',
      };
    }
    return {
      id: 'amazon.rdt',
      label: 'Restricted Data Token (RDT)',
      status: 'fail',
      detail: `RDT respondeu HTTP ${response.status}: ${summary}`,
      latencyMs,
      remediation:
        'Confira se AMAZON_DIAGNOSE_ORDER_ID existe nesta conta e se o app pode solicitar buyerInfo/shippingAddress.',
    };
  }

  const token = readString(body.restrictedDataToken);
  const expiresIn = readNumber(body.expiresIn);
  if (!token) {
    return {
      id: 'amazon.rdt',
      label: 'Restricted Data Token (RDT)',
      status: 'fail',
      detail: 'Resposta HTTP 200 do RDT sem `restrictedDataToken`.',
      latencyMs,
      remediation:
        'Resposta inesperada do endpoint RDT — confirme AMAZON_RDT_ENDPOINT (…/tokens/2021-03-01/restrictedDataToken).',
    };
  }

  return {
    id: 'amazon.rdt',
    label: 'Restricted Data Token (RDT)',
    status: 'ok',
    detail: `RDT emitido para GET ${restrictedPath} (dataElements: ${AMAZON_RDT_DATA_ELEMENTS.join(
      ', ',
    )}${expiresIn ? `, expira em ${expiresIn}s` : ''}).`,
    latencyMs,
  };
}

/* ==========================================================================
 * Helpers
 * ========================================================================== */

function readDiagnoseOrderId(account: MarketplaceAccountRecord): string | null {
  const fromEnv = readString(process.env[AMAZON_DIAGNOSE_ORDER_ID_ENV]);
  if (fromEnv) return fromEnv;
  return readString(account.channelConfig.diagnose_order_id);
}

function skipCheck(id: string, label: string, detail: string): DiagnosisCheck {
  return { id, label, status: 'skipped', detail };
}

function remediationForLwaError(errorCode: string | null): string {
  switch (errorCode) {
    case 'invalid_grant':
      return 'Refresh token inválido, expirado ou revogado — regenere o token no Seller Central (Apps & Services > Develop Apps) e reconecte a conta Amazon.';
    case 'invalid_client':
      return 'Client ID/Secret inválidos — revise AMAZON_LWA_CLIENT_ID e AMAZON_LWA_CLIENT_SECRET no .env.';
    case 'unauthorized_client':
      return 'O app não está autorizado para esta conta — reautorize a aplicação no Seller Central.';
    default:
      return 'Revise as credenciais LWA no Seller Central e reconecte a conta Amazon.';
  }
}

function describeAmazonError(body: unknown): string {
  const record = asRecord(body);
  const lwaError = readString(record.error);
  if (lwaError) {
    const description = readString(record.error_description);
    return truncateDiagnosticText(
      description ? `${lwaError}: ${description}` : lwaError,
      300,
    );
  }
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const parts: string[] = [];
  for (const entry of errors) {
    const error = asRecord(entry);
    const part = [readString(error.code), readString(error.message), readString(error.details)]
      .filter((value): value is string => value !== null)
      .join(' — ');
    if (part) parts.push(part);
  }
  return parts.length > 0 ? truncateDiagnosticText(parts.join('; '), 300) : 'sem detalhes';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateDiagnosticText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function logDiagnosis(
  deps: AdapterDependencies,
  accountId: string,
  checks: DiagnosisCheck[],
): void {
  const logger = deps.logger.child({ component: 'amazon.diagnose' });
  const statuses = checks.map((check) => `${check.id}=${check.status}`).join(',');
  if (checks.some((check) => check.status === 'fail')) {
    logger.warn('amazon.diagnose.failed', { accountId, statuses });
  } else {
    logger.info('amazon.diagnose.completed', { accountId, statuses });
  }
}
