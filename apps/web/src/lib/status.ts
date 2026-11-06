/**
 * Presentation helpers for the public `/status` page.
 *
 * The endpoint is public and can be deployed ahead of this UI, so values are
 * normalised defensively (case/alias tolerant) — but never invented: anything
 * the API did not answer renders as "não informado"/neutral instead of
 * "operational". No mock data lives here.
 */
import type { Marketplace } from '@sac/shared';

import { ApiClientError } from './api';
import { formatDateTime } from './format';
import type { SystemStatusChannel, SystemStatusServiceName } from './types';

/** Polling cadence of the public status page (60 s). */
export const STATUS_POLL_INTERVAL_MS = 60_000;

/** Convergência tone family used by the status pills (`Pill` accepts it). */
export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger';

export type StatusLevel = 'operational' | 'degraded' | 'down';

export interface LevelPresentation {
  tone: StatusTone;
  label: string;
  /** True only for the three values the API contract defines. */
  recognized: boolean;
}

const LEVEL_LABEL: Record<StatusLevel, string> = {
  operational: 'Operacional',
  degraded: 'Degradado',
  down: 'Indisponível',
};

const LEVEL_TONE: Record<StatusLevel, StatusTone> = {
  operational: 'ok',
  degraded: 'warn',
  down: 'danger',
};

function isStatusLevel(value: string): value is StatusLevel {
  return value === 'operational' || value === 'degraded' || value === 'down';
}

/** Maps the raw API level to label + DS tone without hiding unknown values. */
export function levelPresentation(value: unknown): LevelPresentation {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isStatusLevel(key)) {
    return { tone: LEVEL_TONE[key], label: LEVEL_LABEL[key], recognized: true };
  }
  return {
    tone: 'neutral',
    label: typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'Não informado',
    recognized: false,
  };
}

const MARKETPLACE_ALIAS: Record<string, Marketplace> = {
  AMAZON: 'AMAZON',
  AMZ: 'AMAZON',
  MERCADO_LIVRE: 'MERCADO_LIVRE',
  MERCADOLIVRE: 'MERCADO_LIVRE',
  MELI: 'MERCADO_LIVRE',
  SHOPEE: 'SHOPEE',
};

/** Tolerant marketplace lookup: `mercadolivre`, `MERCADO LIVRE` and `MELI`. */
export function normalizeMarketplace(value: unknown): Marketplace | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return MARKETPLACE_ALIAS[key] ?? null;
}

/** Raw marketplace text for the fallback chip when the slug is unknown. */
export function rawMarketplaceLabel(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : 'Marketplace não informado';
}

/** `123 ms` — latency is a real measurement, so an absent value stays `—`. */
export function latencyLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${Math.round(value)} ms`
    : '—';
}

const SERVICE_LABEL: Record<SystemStatusServiceName, string> = {
  api: 'API',
  database: 'Banco de dados',
  redis: 'Redis',
  storage: 'Armazenamento',
};

/**
 * Human label for the probed dependency. The contract enumerates
 * `api | database | redis | storage`; a newer server adding another probe keeps
 * working because an unknown name renders exactly as it was sent.
 */
export function serviceLabel(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (key === 'api' || key === 'database' || key === 'redis' || key === 'storage') {
    return SERVICE_LABEL[key];
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'Serviço sem nome';
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export interface ChannelSummary {
  tone: StatusTone;
  accounts: number | null;
  healthy: number | null;
  /**
   * `2/3 contas saudáveis` — the healthy/accounts pair the API reports, in one
   * label so the pill stays readable at 390px.
   */
  label: string;
}

/** Derives the channel pill from the real `healthy`/`accounts` counts. */
export function summarizeChannel(channel: SystemStatusChannel): ChannelSummary {
  const accounts = asCount(channel.accounts);
  const healthy = asCount(channel.healthy);

  if (accounts === null || healthy === null) {
    return {
      tone: 'neutral',
      accounts,
      healthy,
      label: 'Contagem de contas não informada',
    };
  }
  if (accounts === 0) {
    return { tone: 'neutral', accounts, healthy, label: 'Nenhuma conta conectada' };
  }

  const tone: StatusTone = healthy >= accounts ? 'ok' : healthy === 0 ? 'danger' : 'warn';
  return { tone, accounts, healthy, label: `${healthy}/${accounts} contas saudáveis` };
}

/** `Nenhum erro registrado` or the real timestamp of the last reported failure. */
export function lastErrorLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Nenhum erro registrado';
  }
  const formatted = formatDateTime(value);
  return formatted === '—' ? 'Último erro em data inválida' : `Último erro em ${formatted}`;
}

/**
 * Real failure message for the page. Never replaced by a friendly fake: a 5xx,
 * timeout or a status endpoint that was not published must read as such.
 */
export function statusErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 0) return error.message;
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return `${error.message} (HTTP ${error.status}) — o painel público de status não está disponível nesta instalação.`;
    }
    // A generic envelope already carries the status ("Erro HTTP 500."); avoid
    // printing it twice while keeping the real server message intact.
    return error.message.includes(`HTTP ${error.status}`)
      ? error.message
      : `${error.message} (HTTP ${error.status})`;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Não foi possível consultar o status. Tente novamente.';
}
