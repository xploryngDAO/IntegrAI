/**
 * Setup de apps de integração — presentation helpers (Fase 3).
 *
 * `GET /platform/integration-setup` is the only source of truth: the page
 * renders the redirect URI, webhook URL, topics/scopes and steps the API
 * returned, and never invents a value. The helpers below only:
 *   - normalise the marketplace identifier (the endpoint is new and may answer
 *     `meli`, `MERCADO_LIVRE` or `mercado-livre` for the same channel);
 *   - order the cards (Amazon, Mercado Livre, Shopee; unknown channels last);
 *   - accept only absolute http(s) URLs for the portal/docs links;
 *   - turn failures into operator-facing copy (403, not published, network).
 */
import type { Marketplace } from '@sac/shared';

import { ApiClientError } from './api';
import { MARKETPLACE_LABEL } from './labels';

/** Display order of the channels the product operates. */
const KNOWN_ORDER: readonly Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];

/**
 * Accepted spellings per channel. Keys are produced by `normalizedKey`
 * (accent-insensitive, upper case, `-`/spaces → `_`).
 */
const MARKETPLACE_ALIASES: Record<string, Marketplace> = {
  AMAZON: 'AMAZON',
  AMZ: 'AMAZON',
  AMAZON_SP_API: 'AMAZON',
  AMAZON_SPAPI: 'AMAZON',
  MERCADO_LIVRE: 'MERCADO_LIVRE',
  MERCADO_LIBRE: 'MERCADO_LIVRE',
  MERCADOLIVRE: 'MERCADO_LIVRE',
  MERCADO_LIVRE_MELI: 'MERCADO_LIVRE',
  MELI: 'MERCADO_LIVRE',
  SHOPEE: 'SHOPEE',
  SHOPEE_OPEN_PLATFORM: 'SHOPEE',
};

function normalizedKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/** Canonical marketplace of a raw API identifier (`null` when unknown). */
export function toMarketplace(value: string | null | undefined): Marketplace | null {
  if (typeof value !== 'string') return null;
  const key = normalizedKey(value);
  if (key.length === 0) return null;
  return MARKETPLACE_ALIASES[key] ?? null;
}

/** Card title: canonical label when known, a readable raw label otherwise. */
export function integrationChannelLabel(value: string): string {
  const marketplace = toMarketplace(value);
  if (marketplace !== null) return MARKETPLACE_LABEL[marketplace];
  const humanized = value.replace(/[_-]+/g, ' ').trim();
  return humanized.length > 0 ? humanized : 'Canal não identificado';
}

function channelRank(value: string): number {
  const marketplace = toMarketplace(value);
  if (marketplace === null) return KNOWN_ORDER.length;
  const index = KNOWN_ORDER.indexOf(marketplace);
  return index >= 0 ? index : KNOWN_ORDER.length;
}

/**
 * Stable order for the cards: known marketplaces first (operator order), then
 * any channel the API adds later, alphabetically. Sorting never drops an entry.
 */
export function sortIntegrationChannels<T extends { marketplace: string }>(
  channels: readonly T[],
): T[] {
  return [...channels].sort((left, right) => {
    const rankDiff = channelRank(left.marketplace) - channelRank(right.marketplace);
    if (rankDiff !== 0) return rankDiff;
    return integrationChannelLabel(left.marketplace).localeCompare(
      integrationChannelLabel(right.marketplace),
      'pt-BR',
    );
  });
}

/**
 * A channel is ready only when the API says it is AND it lists no missing env
 * variable. Shared by the status pill and by the generated `.env`/checklist so
 * the three never disagree about what "pendente" means.
 */
export function isIntegrationChannelComplete(channel: {
  configured: boolean;
  missing: readonly string[];
}): boolean {
  return channel.configured && channel.missing.length === 0;
}

/** Absolute http(s) URL guard for the portal/docs links returned by the API. */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Failure of `GET /platform/integration-setup`. */
export function integrationSetupErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para ver a configuração das integrações.';
    }
    if (error.status === 403) {
      return 'Sua conta não tem permissão para ver a configuração das integrações.';
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return `A configuração de integrações não está publicada nesta API (HTTP ${error.status}). Atualize a API e tente novamente.`;
    }
    if (error.status === 422) {
      return `${error.message} Revise os parâmetros e tente novamente.`;
    }
    if (error.status === 0) return error.message;
    const code = error.code && error.code !== 'HTTP_ERROR' ? ` (${error.code})` : '';
    return `${error.message} (HTTP ${error.status})${code}`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/** Failure of the connection test (reuses the existing diagnostics calls). */
export function connectionTestErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) {
      return 'Seu papel não permite executar o diagnóstico do workspace (HTTP 403). Apenas um ADMIN do workspace pode testar as credenciais.';
    }
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para testar a conexão.';
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return `O diagnóstico não está publicado nesta API (HTTP ${error.status}).`;
    }
    if (error.status === 0) return error.message;
    return `${error.message} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível executar o teste de conexão. Tente novamente.';
}
