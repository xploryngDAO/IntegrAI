import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import {
  SSO_MAX_ALLOWED_DOMAINS,
  SSO_PROVIDER_MICROSOFT,
  SSO_ROLE_SELECT,
  SSO_SECRET_MIN_LENGTH,
  formatAllowedDomains,
  formatGroupRoleMap,
  hasSsoConfiguration,
  isValidIssuerUrl,
  parseAllowedDomains,
  parseGroupRoleMap,
  ssoErrorMessage,
  ssoProviderLabel,
  ssoRedirectUri,
} from '../../lib/sso';
import type { TenantSsoConfig, TenantSsoUpdate } from '../../lib/types';
import {
  Alert,
  Button,
  Card,
  FieldRow,
  IconButton,
  Input,
  Pill,
  Select,
  Skeleton,
  Textarea,
  Toggle,
} from '../ui';

/** Editable mirror of the API config. The secret is write-only (always empty). */
interface SsoForm {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  groupRoleMapText: string;
  autoProvision: boolean;
  defaultRole: string;
  enforceSso: boolean;
  enabled: boolean;
}

interface SsoFieldErrors {
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  allowedDomains?: string;
  groupRoleMap?: string;
}

/**
 * Initial form state.
 *
 * A brand-new configuration starts enabled and with auto-provisioning on: the
 * reason to configure SSO is to let the team in. An existing configuration is
 * mirrored exactly as the API returned it — never "improved" client-side.
 */
function formFromConfig(config: TenantSsoConfig | null): SsoForm {
  return {
    issuerUrl: config?.issuerUrl ?? '',
    clientId: config?.clientId ?? '',
    clientSecret: '',
    domains: formatAllowedDomains(config?.allowedDomains ?? []),
    groupRoleMapText: formatGroupRoleMap(config?.groupRoleMap ?? {}),
    autoProvision: config?.autoProvision ?? true,
    defaultRole: config?.defaultRole || 'AGENT',
    enforceSso: config?.enforceSso ?? false,
    enabled: config?.enabled ?? true,
  };
}

/**
 * "Autenticação corporativa" section of `/settings` (tenant ADMIN).
 *
 * Form for the Microsoft Entra ID (OIDC) app registration: issuer URL, client
 * id, write-only client secret, the read-only callback URL the IdP must call,
 * allowed e-mail domains, provisioning and enforcement switches.
 *
 * Data comes only from `GET/PUT/DELETE /tenants/me/sso`; a `403`/`422` from the
 * API is rendered verbatim instead of being turned into a generic error. The
 * secret is never read back — the card only shows whether one is stored.
 */
export function CorporateAuthCard(): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);

  const [config, setConfig] = useState<TenantSsoConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [form, setForm] = useState<SsoForm>(() => formFromConfig(null));
  const [fieldErrors, setFieldErrors] = useState<SsoFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  function patchForm(patch: Partial<SsoForm>): void {
    setForm((current) => ({ ...current, ...patch }));
    setFormError(null);
    setFieldErrors({});
  }

  useEffect(() => {
    let active = true;

    async function loadConfig(): Promise<void> {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.tenantSso();
        if (!active) return;
        setConfig(result);
        setForm(formFromConfig(result));
        setFieldErrors({});
        setFormError(null);
        setDeleteError(null);
        setConfirmingDelete(false);
      } catch (error) {
        if (!active) return;
        setConfig(null);
        setLoadError(ssoErrorMessage(error, 'read'));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadConfig();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // The callback URL is what the operator registers at the IdP. The API is
  // authoritative when it publishes one; otherwise it is derived from the same
  // base the client uses, so it can never drift from the deployed API.
  const redirectUri = config?.redirectUri ?? ssoRedirectUri();
  const configured = hasSsoConfiguration(config);

  async function copyRedirectUri(): Promise<void> {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
      pushToast({
        tone: 'ok',
        title: 'Redirect URI copiada',
        description: 'Cadastre exatamente esta URL no app registration do Entra ID.',
      });
    } catch {
      pushToast({
        tone: 'warn',
        title: 'Não foi possível copiar',
        description: 'Selecione o texto do campo e copie manualmente.',
      });
    }
  }

  async function handleSave(): Promise<void> {
    if (saving) return;

    const issuerUrl = form.issuerUrl.trim();
    const clientId = form.clientId.trim();
    const clientSecret = form.clientSecret.trim();
    const parsedDomains = parseAllowedDomains(form.domains);
    const parsedGroupRoles = parseGroupRoleMap(form.groupRoleMapText);

    const errors: SsoFieldErrors = {};
    if (!isValidIssuerUrl(issuerUrl)) {
      errors.issuerUrl = 'Informe a Issuer URL OIDC do Entra ID (https://login.microsoftonline.com/…/v2.0).';
    }
    if (clientId.length === 0) {
      errors.clientId = 'Informe o Client ID (Application ID) do app registration.';
    }
    if (clientSecret.length > 0 && clientSecret.length < SSO_SECRET_MIN_LENGTH) {
      errors.clientSecret = `O client secret precisa de pelo menos ${SSO_SECRET_MIN_LENGTH} caracteres (a API recusa valores menores).`;
    }
    if (parsedDomains.invalid.length > 0) {
      errors.allowedDomains = `Domínio inválido: ${parsedDomains.invalid.join(', ')}. Use apenas o domínio (ex.: suaempresa.com.br).`;
    } else if (parsedDomains.domains.length > SSO_MAX_ALLOWED_DOMAINS) {
      errors.allowedDomains = `A API aceita no máximo ${SSO_MAX_ALLOWED_DOMAINS} domínios por configuração.`;
    } else if (form.enforceSso && parsedDomains.domains.length === 0) {
      // The API rejects `enforceSso` without an allowlist: nobody would be able
      // to sign in and only the platform operator could unlock the workspace.
      errors.allowedDomains = 'Exigir SSO precisa de pelo menos um domínio permitido.';
    }
    if (parsedGroupRoles.error !== null) {
      errors.groupRoleMap = parsedGroupRoles.error;
    }

    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    // The callback URL is read-only and derived by the API: it is deliberately
    // not sent. `groupRoleMap` travels as the map typed above (empty clears it),
    // because PUT replaces the whole configuration.
    const body: TenantSsoUpdate = {
      provider: config?.provider.trim() || SSO_PROVIDER_MICROSOFT,
      issuerUrl,
      clientId,
      allowedDomains: parsedDomains.domains,
      groupRoleMap: parsedGroupRoles.map,
      autoProvision: form.autoProvision,
      defaultRole: form.defaultRole,
      enforceSso: form.enforceSso,
      enabled: form.enabled,
    };
    // Omitted = keep the stored secret (the API never returns it).
    if (clientSecret.length > 0) body.clientSecret = clientSecret;

    setSaving(true);
    try {
      const saved = await api.updateTenantSso(body);
      // A 204 answers no body: re-read the authoritative state instead of
      // assuming what was stored.
      const next = saved ?? (await api.tenantSso());
      setConfig(next);
      setForm(formFromConfig(next));
      setFieldErrors({});
      pushToast({
        tone: 'ok',
        title: 'Autenticação corporativa salva',
        description: next?.enabled
          ? 'O login com Microsoft está habilitado para os domínios configurados.'
          : 'A configuração foi salva com o SSO desabilitado.',
      });
    } catch (error) {
      setFormError(ssoErrorMessage(error, 'save'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteTenantSso();
      const next = await api.tenantSso();
      setConfig(next);
      setForm(formFromConfig(next));
      setFieldErrors({});
      setFormError(null);
      setConfirmingDelete(false);
      pushToast({
        tone: 'ok',
        title: 'Configuração de SSO removida',
        description: 'O login corporativo foi desligado e os identificadores foram apagados.',
      });
    } catch (error) {
      setDeleteError(ssoErrorMessage(error, 'delete'));
    } finally {
      setDeleting(false);
    }
  }

  const statusPills = (
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone={config?.enabled ? 'ok' : 'neutral'}>
        {config?.enabled ? 'Habilitado' : 'Desabilitado'}
      </Pill>
      <Pill tone={configured ? 'ok' : 'neutral'}>{configured ? 'Configurado' : 'Não configurado'}</Pill>
      {configured && !config?.clientSecretConfigured ? <Pill tone="info">Cliente público</Pill> : null}
      <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        {ssoProviderLabel(config?.provider)} · OIDC
      </span>
    </div>
  );

  return (
    <Card
      title={ssoProviderLabel(config?.provider)}
      subtitle="Provedor OIDC do workspace · estado real de GET/PUT/DELETE /tenants/me/sso."
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : loadError !== null ? (
        <Alert title="Não foi possível ler a autenticação corporativa" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{loadError}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={retry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {statusPills}

          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {configured
              ? 'A configuração abaixo fala com a API real do workspace. O client secret é write-only: a API informa apenas se existe um secret guardado.'
              : 'Nenhuma configuração salva neste workspace. Preencha os dados do app registration no Entra ID (App registrations → sua aplicação) para habilitar o login com Microsoft.'}
          </p>

          <div className="sac-divider" />

          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <Input
              label="Issuer URL (OIDC)"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={form.issuerUrl}
              placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0"
              hint="Autoridade OIDC do diretório, com /v2.0 e sem barra no final. Use o ID do diretório, não /common."
              error={fieldErrors.issuerUrl}
              onChange={(event) => patchForm({ issuerUrl: event.target.value })}
              required
            />

            <FieldRow>
              <Input
                label="Client ID (Application ID)"
                autoComplete="off"
                spellCheck={false}
                value={form.clientId}
                placeholder="00000000-0000-0000-0000-000000000000"
                error={fieldErrors.clientId}
                onChange={(event) => patchForm({ clientId: event.target.value })}
                required
              />
              <Input
                label="Client secret"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={form.clientSecret}
                placeholder={
                  config?.clientSecretConfigured ? '•••• (configurado)' : 'Cole o secret do app registration'
                }
                hint={
                  config?.clientSecretConfigured
                    ? 'Deixe em branco para manter o secret atual. O valor nunca é exibido pela API.'
                    : 'Opcional: sem secret a API usa um cliente público (PKCE). Guardado cifrado, nunca exibido de volta.'
                }
                error={fieldErrors.clientSecret}
                onChange={(event) => patchForm({ clientSecret: event.target.value })}
              />
            </FieldRow>

            <div className="flex flex-col gap-1.5">
              <span className="sac-label">Redirect URI (callback)</span>
              <div className="flex items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
                <code
                  className="sac-num m-0 min-w-0 flex-1 select-all break-words text-[var(--cv-font-meta)]"
                  title={redirectUri}
                >
                  {redirectUri}
                </code>
                <IconButton
                  label="Copiar a Redirect URI"
                  icon={copied ? <Check size={15} /> : <Copy size={15} />}
                  onClick={() => void copyRedirectUri()}
                />
              </div>
              <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                Read-only: cadastre exatamente esta URL no app registration do Entra ID (plataforma
                Web). A API é a dona do valor — não é editável aqui.
              </p>
            </div>

            <Textarea
              label="Domínios permitidos"
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={form.domains}
              placeholder={'suaempresa.com.br\nfilial.suaempresa.com.br'}
              hint="Um domínio por linha. A API casa o domínio do e-mail com esta lista: sem domínios, nenhum login corporativo é aceito."
              error={fieldErrors.allowedDomains}
              onChange={(event) => patchForm({ domains: event.target.value })}
            />

            <Select
              label="Papel padrão"
              value={form.defaultRole}
              options={SSO_ROLE_SELECT}
              hint="Papel do operador criado pelo provisionamento automático (quando nenhum grupo mapeia um papel)."
              onChange={(event) => patchForm({ defaultRole: event.target.value })}
            />

            <Textarea
              label="Mapeamento de grupos → papel (JSON)"
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={form.groupRoleMapText}
              placeholder={'{\n  "00000000-0000-0000-0000-000000000000": "ADMIN"\n}'}
              hint='Opcional: o object id do grupo do Entra ID como chave e ADMIN, SUPERVISOR ou AGENT como valor. O maior privilégio vence; grupo não mapeado mantém o papel atual. Vazio remove o mapeamento.'
              error={fieldErrors.groupRoleMap}
              onChange={(event) => patchForm({ groupRoleMapText: event.target.value })}
            />

            <div className="flex flex-col gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-3 py-2.5">
              <span className="sac-label">Comportamento do login</span>
              <Toggle
                label="Provisionar operador no primeiro login"
                checked={form.autoProvision}
                onChange={(checked) => patchForm({ autoProvision: checked })}
              />
              <Toggle
                label="Exigir SSO (recusar login por senha)"
                checked={form.enforceSso}
                onChange={(checked) => patchForm({ enforceSso: checked })}
              />
              <Toggle
                label="SSO habilitado neste workspace"
                checked={form.enabled}
                onChange={(checked) => patchForm({ enabled: checked })}
              />
              <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                Provisionar cria o operador com o papel padrão quando o e-mail ainda não existe.
                Exigir SSO faz a API recusar a senha e aceitar somente o login corporativo.
                Desabilitar mantém os dados salvos, sem uso no login.
              </p>
            </div>

            {formError !== null ? (
              <Alert title="Não foi possível salvar a configuração" tone="danger">
                {formError}
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="submit"
                variant="primary"
                icon="check"
                loading={saving}
                disabled={deleting}
              >
                Salvar configuração
              </Button>
              <Button
                type="button"
                variant="secondary"
                icon="pulse"
                onClick={retry}
                disabled={saving || deleting}
              >
                Recarregar
              </Button>
            </div>
          </form>

          <div className="sac-divider" />

          {confirmingDelete ? (
            <div className="flex flex-col gap-2">
              <Alert title="Remover a configuração de SSO" tone="warning">
                O login com Microsoft deixa de funcionar imediatamente e o issuer, o client id e o
                secret são apagados da API.
                {config?.enforceSso
                  ? ' Como “Exigir SSO” está ativo, os operadores dos domínios cobertos podem ficar sem acesso até a configuração ser refeita.'
                  : ''}
              </Alert>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="danger"
                  icon="close"
                  loading={deleting}
                  onClick={() => void handleDelete()}
                >
                  Confirmar remoção
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setConfirmingDelete(false);
                    setDeleteError(null);
                  }}
                  disabled={deleting}
                >
                  Cancelar
                </Button>
              </div>
              {deleteError !== null ? (
                <Alert title="Não foi possível remover a configuração" tone="danger">
                  {deleteError}
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="m-0 text-[var(--cv-font-control)] font-medium">Remover configuração</p>
                <p className="m-0 text-[var(--cv-font-meta)] leading-snug text-[var(--cv-color-text-muted)]">
                  Apaga o SSO deste workspace. Operadores e dados não são alterados.
                </p>
              </div>
              <Button
                type="button"
                variant="danger"
                icon="close"
                disabled={!configured || saving}
                onClick={() => setConfirmingDelete(true)}
              >
                Remover SSO
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
