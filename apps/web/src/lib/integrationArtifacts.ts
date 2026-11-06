/**
 * Artefatos de setup das integrações — gerados 100% no navegador.
 *
 * `GET /platform/integration-setup` devolve apenas valores públicos: app id,
 * URLs exatas e os NOMES das variáveis de ambiente que faltam. Os geradores
 * abaixo obedecem à mesma regra:
 *
 *   - o `.env` lista somente os canais pendentes e escreve as chaves SEM valor
 *     (a API nunca devolve segredo, então nada é inventado nem vazado);
 *   - o checklist em markdown também lista somente os pendentes, com as URLs
 *     exatas, os links de portal/documentação e os passos publicados.
 *
 * Campos nulos/ausentes viram texto ("não informado pela API") em vez de
 * quebrar a geração: a tela precisa continuar util quando a API responde
 * parcialmente.
 */
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import {
  integrationChannelLabel,
  isHttpUrl,
  isIntegrationChannelComplete,
} from './integrations';
import type { IntegrationSetupChannel } from './types';

/** Nome fixo do arquivo baixado pelo botão do cabeçalho. */
export const INTEGRATION_ENV_FILENAME = 'integrai-integrations.env';

/** Subconjunto da resposta usado pelos geradores (facilita testes/reuso). */
export interface IntegrationArtifactsInput {
  channels: readonly IntegrationSetupChannel[];
  /** Instante da leitura da API (`IntegrationSetup.generatedAt`). */
  generatedAt?: string;
  apiBaseUrl?: string;
  webOrigin?: string;
}

/** Nome de variável aceito em um `.env` (evita injetar linhas arbitrárias). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Canais que ainda precisam de ação (mesma regra do pill da tela). */
export function pendingIntegrationChannels(
  channels: readonly IntegrationSetupChannel[],
): IntegrationSetupChannel[] {
  return channels.filter((channel) => !isIntegrationChannelComplete(channel));
}

/** `05/11/2026 às 23:20` no fuso do navegador; vazio quando a data é inválida. */
function timestamp(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return format(date, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
}

/** Texto de uma linha só: comentários e passos nunca escapam do prefixo `#`. */
function oneLine(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Nomes válidos, sem vazios nem repetições, na ordem publicada pela API. */
function envNames(values: readonly string[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!ENV_NAME_PATTERN.test(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** Absolute http(s) URL only; anything else is reported as not published. */
function urlOrMissing(value: string | null | undefined): string {
  const url = oneLine(value);
  return isHttpUrl(url) ? url : 'não informado pela API';
}

/** URLs e valores públicos aparecem como vieram; vazio vira aviso explícito. */
function linkOrMissing(value: string | null | undefined, label: string): string {
  const url = oneLine(value);
  return isHttpUrl(url) ? `[${label}](${url})` : 'não informado pela API';
}

function scopesOf(channel: IntegrationSetupChannel): string[] {
  return channel.oauthScopesOrTopics
    .map((scope) => oneLine(scope))
    .filter((scope) => scope.length > 0);
}

function stepsOf(channel: IntegrationSetupChannel): string[] {
  return channel.steps.map((step) => oneLine(step)).filter((step) => step.length > 0);
}

/** Env var name of the webhook secret (`null` when the channel does not sign). */
function secretEnvName(channel: IntegrationSetupChannel): string | undefined {
  return envNames(channel.webhookSecretEnv === null ? [] : [channel.webhookSecretEnv])[0];
}

/** Variáveis a preencher, incluindo o segredo de webhook (sempre sem valor). */
function pendingEnvNames(channel: IntegrationSetupChannel): string[] {
  const names = envNames(channel.missing);
  const secretEnv = secretEnvName(channel);
  if (secretEnv !== undefined && !names.includes(secretEnv)) names.push(secretEnv);
  return names;
}

function pendingReason(channel: IntegrationSetupChannel): string {
  const missing = envNames(channel.missing);
  if (missing.length > 0) return `faltam ${missing.join(', ')}`;
  return 'a API não informou quais variáveis faltam';
}

function pendingReasonMarkdown(channel: IntegrationSetupChannel): string {
  const missing = envNames(channel.missing);
  if (missing.length > 0) return `faltam ${missing.map((env) => `\`${env}\``).join(', ')}`;
  return 'a API não informou quais variáveis faltam';
}

function missingValuesNote(): string[] {
  return [
    '# Preencha as chaves vazias no ambiente da API, reinicie o processo e',
    '# atualize /setup. A API nunca retorna segredos: por isso toda variável',
    '# abaixo sai sem valor. Os valores públicos e as URLs exatas estão nos',
    '# comentários de cada canal.',
  ];
}

/**
 * Conteúdo de `integrai-integrations.env`.
 *
 * Somente canais pendentes entram no arquivo: um canal configurado não deve
 * aparecer com uma chave vazia que o operador possa colar por cima do valor
 * real. Quando não há pendências, o arquivo apenas informa isso.
 */
export function buildIntegrationEnvFile(
  input: IntegrationArtifactsInput,
  generatedAt: Date = new Date(),
): string {
  const pending = pendingIntegrationChannels(input.channels);
  const lines: string[] = [];

  lines.push('# IntegrAI — variáveis de ambiente das integrações');
  lines.push(`# Gerado no navegador em ${timestamp(generatedAt)}.`);
  lines.push(
    `# Leitura da API (GET /platform/integration-setup): ${
      timestamp(input.generatedAt) || 'não informada'
    }.`,
  );
  if (oneLine(input.apiBaseUrl).length > 0) lines.push(`# API: ${oneLine(input.apiBaseUrl)}`);
  if (oneLine(input.webOrigin).length > 0) lines.push(`# Web: ${oneLine(input.webOrigin)}`);
  lines.push(
    `# Canais pendentes: ${pending.length} de ${input.channels.length} publicado(s).`,
  );
  lines.push('#');
  lines.push(...missingValuesNote());
  lines.push('');

  if (pending.length === 0) {
    lines.push(
      input.channels.length === 0
        ? '# A API não retornou canais de integração nesta leitura; nada a preencher.'
        : '# Nenhum canal pendente: todos os canais publicados já estão configurados.',
    );
    lines.push('# Este arquivo não precisa ser aplicado.');
    return `${lines.join('\n')}\n`;
  }

  for (const channel of pending) {
    const label = integrationChannelLabel(channel.marketplace);
    const rawMarketplace = oneLine(channel.marketplace);
    const envs = pendingEnvNames(channel);
    const secretEnv = secretEnvName(channel);
    const scopes = scopesOf(channel);
    const steps = stepsOf(channel);

    lines.push(
      '# ==========================================================================',
    );
    lines.push(`# ${label} (${rawMarketplace})`);
    lines.push(`# Status: Pendente — ${pendingReason(channel)}`);
    lines.push(`# Portal: ${urlOrMissing(channel.portalUrl)}`);
    lines.push(`# Docs: ${urlOrMissing(channel.docsUrl)}`);
    const appId = oneLine(channel.appIdPublic);
    const redirectUri = oneLine(channel.redirectUri);
    const webhookUrl = oneLine(channel.webhookUrl);
    lines.push(`# App ID / Client ID público: ${appId || 'não informado pela API'}`);
    lines.push(`# REDIRECT_URI: ${redirectUri || 'não informado pela API'}`);
    lines.push(`# WEBHOOK_URL: ${webhookUrl || 'não informado pela API'}`);
    if (redirectUri.length > 0 || webhookUrl.length > 0) {
      lines.push('# Registre no portal exatamente as URLs acima.');
    }
    lines.push(
      `# Escopos / tópicos: ${
        scopes.length > 0 ? scopes.join(', ') : 'não informado pela API'
      }`,
    );
    lines.push('# Passos no portal:');
    if (steps.length === 0) {
      lines.push('#   (a API não publicou passos para este canal)');
    } else {
      steps.forEach((step, index) => lines.push(`#   ${index + 1}. ${step}`));
    }

    if (envs.length === 0) {
      lines.push('# Nenhuma variável de ambiente pendente neste canal.');
    } else {
      lines.push('# Variáveis a preencher (valores vazios de propósito):');
      for (const env of envs) {
        if (secretEnv !== undefined && env === secretEnv) {
          lines.push('# Segredo do webhook — a API não retorna o valor:');
        }
        lines.push(`${env}=`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Conteúdo markdown do "Copiar checklist".
 *
 * Um canal por seção, apenas os pendentes. As URLs exatas ficam em code spans
 * para não dependerem de autolink do editor; portal/documentação viram links.
 */
export function buildIntegrationChecklist(
  input: IntegrationArtifactsInput,
  generatedAt: Date = new Date(),
): string {
  const pending = pendingIntegrationChannels(input.channels);
  const total = input.channels.length;
  const lines: string[] = ['# Checklist de integração — IntegrAI', ''];

  lines.push(`Gerado no navegador em ${timestamp(generatedAt)}.`);
  lines.push(
    `Leitura da API: ${timestamp(input.generatedAt) || 'não informada'} (GET /platform/integration-setup).`,
  );
  if (oneLine(input.apiBaseUrl).length > 0) lines.push(`API: ${oneLine(input.apiBaseUrl)}`);
  lines.push(`Canais pendentes: **${pending.length}** de **${total}** publicado(s).`);
  lines.push('');

  if (total === 0) {
    lines.push('A API não retornou canais de integração nesta leitura. Nada a fazer por aqui.');
    return `${lines.join('\n')}\n`;
  }

  if (pending.length === 0) {
    lines.push(
      'Nenhum canal pendente: todos os canais publicados estão configurados. Nada a fazer nos portais.',
    );
    return `${lines.join('\n')}\n`;
  }

  for (const channel of pending) {
    const label = integrationChannelLabel(channel.marketplace);
    const rawMarketplace = oneLine(channel.marketplace);
    const scopes = scopesOf(channel);
    const steps = stepsOf(channel);
    const secretEnv = secretEnvName(channel);

    lines.push(`## ${label} (\`${rawMarketplace}\`)`, '');
    lines.push(`- **Status:** Pendente — ${pendingReasonMarkdown(channel)}.`);
    lines.push(
      `- **App ID / Client ID público:** ${
        oneLine(channel.appIdPublic) ? `\`${oneLine(channel.appIdPublic)}\`` : 'não informado pela API'
      }`,
    );
    lines.push(
      `- **REDIRECT_URI (exato):** ${
        oneLine(channel.redirectUri) ? `\`${oneLine(channel.redirectUri)}\`` : 'não informado pela API'
      }`,
    );
    lines.push(
      `- **WEBHOOK_URL (exato):** ${
        oneLine(channel.webhookUrl) ? `\`${oneLine(channel.webhookUrl)}\`` : 'não informado pela API'
      }`,
    );
    lines.push(
      `- **Escopos / tópicos:** ${
        scopes.length > 0
          ? scopes.map((scope) => `\`${scope}\``).join(', ')
          : 'não informado pela API'
      }`,
    );
    if (secretEnv !== undefined) {
      lines.push(
        `- **Segredo do webhook:** \`${secretEnv}\` (o valor nunca é retornado pela API)`,
      );
    }
    lines.push(
      `- **Portal:** ${linkOrMissing(channel.portalUrl, `Abrir portal do ${label}`)}`,
    );
    lines.push(
      `- **Documentação:** ${linkOrMissing(channel.docsUrl, `Documentação de ${label}`)}`,
    );
    lines.push('', '**Passos no portal**', '');
    if (steps.length === 0) {
      lines.push('_A API não publicou passos para este canal._');
    } else {
      steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    }
    lines.push('');
  }

  lines.push(
    '_Nenhum valor secreto é incluído aqui: a API retorna apenas nomes de variáveis e valores públicos._',
  );

  return `${lines.join('\n')}\n`;
}
