import { useEffect, useMemo, useState } from 'react';
import type { ConnectorDescriptor, Marketplace } from '@sac/shared';
import { Stepper } from '@xploryng/convergencia';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import { MARKETPLACE_LABEL } from '../../lib/labels';
import { Alert, Button, Input, Modal, Pill, Select } from '../ui';
import { reloadAccounts } from './ConnectorCard';

type OAuthSlug = 'mercadolivre' | 'shopee';

function oauthSlugOf(marketplace: Marketplace): OAuthSlug {
  return marketplace === 'MERCADO_LIVRE' ? 'mercadolivre' : 'shopee';
}

function initialFieldValues(descriptor: ConnectorDescriptor): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of descriptor.fields) {
    if (field.type === 'select' && field.options && field.options.length > 0) {
      values[field.key] = field.options[0]?.value ?? '';
    } else {
      values[field.key] = '';
    }
  }
  return values;
}

const STEPS = ['Identificação', 'Autorização'];

export interface ConnectModalProps {
  open: boolean;
  onClose: () => void;
  marketplace: Marketplace;
}

/**
 * Marketplace onboarding wizard driven by `GET /accounts/connectors`.
 * Step 1 identifies the store (and collects Amazon credentials); step 2 runs the
 * authorization (OAuth redirect for Meli/Shopee, credential submit for Amazon).
 */
export function ConnectModal({ open, onClose, marketplace }: ConnectModalProps): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);

  const [descriptor, setDescriptor] = useState<ConnectorDescriptor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setStep(0);

    void api
      .connectors()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((entry) => entry.marketplace === marketplace) ?? null;
        if (!found) {
          setLoadError('Conector indisponível para este marketplace.');
          return;
        }
        setDescriptor(found);
        setValues(initialFieldValues(found));
      })
      .catch(() => {
        if (!cancelled) setLoadError('Não foi possível carregar as credenciais do conector.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, marketplace]);

  const fields = useMemo<ConnectorDescriptor['fields']>(() => {
    if (!descriptor) return [];
    if (
      descriptor.authMode === 'OAUTH2' &&
      !descriptor.fields.some((field) => field.key === 'displayName')
    ) {
      return [
        {
          key: 'displayName',
          label: 'Nome da loja',
          type: 'text',
          required: true,
          placeholder: 'Ex.: Loja principal',
          helpText: 'Identificação interna desta conexão no SAC Hub.',
        },
        ...descriptor.fields,
      ];
    }
    return descriptor.fields;
  }, [descriptor]);

  function setValue(key: string, value: string): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !(values[field.key] ?? '').trim()) {
        next[field.key] = 'Informe este campo para continuar.';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function buildDisplayName(): string {
    return (values.displayName ?? '').trim() || `${MARKETPLACE_LABEL[marketplace]} — Loja`;
  }

  async function handleConnect(): Promise<void> {
    if (!descriptor || !validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const sellerId = (values.externalSellerId ?? values.sellerId ?? '').trim();
      const siteId = (values.marketplaceSiteId ?? values.siteId ?? sellerId).trim();
      const refreshToken = (values.refreshToken ?? '').trim();

      const channelConfig: Record<string, unknown> = {};
      const smtpSender = (values.smtp_sender_email ?? '').trim();
      if (smtpSender) channelConfig.smtp_sender_email = smtpSender;
      const inboundRoute = (values.inbound_email_route ?? '').trim();
      if (inboundRoute) channelConfig.inbound_email_route = inboundRoute;
      const approvedDomains = (values.approved_sender_domains ?? '')
        .split(',')
        .map((domain) => domain.trim())
        .filter(Boolean);
      if (approvedDomains.length > 0) channelConfig.approved_sender_domains = approvedDomains;

      const result = await api.connectAccount({
        marketplace,
        displayName: buildDisplayName(),
        externalSellerId: sellerId,
        marketplaceSiteId: siteId,
        refreshToken: refreshToken || undefined,
        channelConfig,
      });
      pushToast({ tone: 'ok', title: 'Loja conectada', description: result.displayName });
      await reloadAccounts();
      onClose();
    } catch {
      setSubmitError('Não foi possível conectar a loja. Revise as credenciais e tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOAuth(): Promise<void> {
    if (!descriptor || !validate()) return;
    setOauthStarting(true);
    setSubmitError(null);
    try {
      const { authorizeUrl } = await api.startOAuth(oauthSlugOf(marketplace), buildDisplayName());
      window.location.assign(authorizeUrl);
    } catch {
      setSubmitError('Não foi possível iniciar a autorização. Verifique as credenciais do app.');
    } finally {
      setOauthStarting(false);
    }
  }

  const isOAuth = descriptor?.authMode === 'OAUTH2';
  const busy = submitting || oauthStarting;

  function renderField(field: ConnectorDescriptor['fields'][number], index: number): JSX.Element {
    const value = values[field.key] ?? '';
    const label = `${field.label}${field.required ? ' *' : ''}`;
    const isSecret = field.type === 'password' || field.secret === true;

    if (field.type === 'select') {
      return (
        <Select
          key={field.key}
          label={label}
          hint={field.helpText}
          error={errors[field.key]}
          options={field.options ?? []}
          value={value}
          onChange={(event) => setValue(field.key, event.target.value)}
        />
      );
    }

    return (
      <Input
        key={field.key}
        label={label}
        hint={field.helpText}
        error={errors[field.key]}
        type={field.type === 'password' ? 'password' : field.type === 'email' ? 'email' : 'text'}
        inputMode={isSecret ? 'text' : undefined}
        autoComplete="off"
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => setValue(field.key, event.target.value)}
        required={field.required}
        id={`connector-field-${index}`}
      />
    );
  }

  const webhookPath =
    marketplace === 'AMAZON'
      ? '/webhooks/amazon/ses'
      : marketplace === 'MERCADO_LIVRE'
        ? '/webhooks/mercadolivre'
        : '/webhooks/shopee';
  const redirectPath =
    marketplace === 'MERCADO_LIVRE'
      ? '/api/v1/accounts/oauth/mercadolivre/callback'
      : marketplace === 'SHOPEE'
        ? '/api/v1/accounts/oauth/shopee/callback'
        : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Conectar ${MARKETPLACE_LABEL[marketplace]}`}
      description={
        isOAuth
          ? 'Autorize a loja no portal do parceiro. Os tokens são cifrados em repouso e renovados automaticamente.'
          : 'Informe as credenciais LWA e o remetente aprovado no Seller Central para habilitar e-mail e mensageria.'
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          {step === 0 ? (
            <Button
              variant="primary"
              disabled={loading || Boolean(loadError)}
              onClick={() => {
                if (validate()) setStep(1);
              }}
            >
              Continuar
            </Button>
          ) : (
            <>
              <Button onClick={() => setStep(0)} disabled={busy}>
                Voltar
              </Button>
              {isOAuth ? (
                <Button variant="primary" loading={oauthStarting} onClick={() => void handleOAuth()}>
                  Autorizar no {MARKETPLACE_LABEL[marketplace]}
                </Button>
              ) : (
                <Button variant="primary" loading={submitting} onClick={() => void handleConnect()}>
                  Conectar loja
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      <Stepper steps={STEPS} current={step} />

      {loadError ? <Alert title="Conector indisponível" tone="danger">{loadError}</Alert> : null}

      {loading ? (
        <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Carregando campos do conector…
        </p>
      ) : null}

      {step === 0 && !loading && !loadError ? (
        <div className="flex flex-col gap-3">
          {fields.map((field, index) => renderField(field, index))}
          {isOAuth ? (
            <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
              O identificador da loja é retornado pelo provedor após a autorização.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="info">{MARKETPLACE_LABEL[marketplace]}</Pill>
            <Pill tone="neutral">{buildDisplayName()}</Pill>
            {isOAuth ? <Pill tone="accent">OAuth 2.0</Pill> : <Pill tone="warn">Credenciais LWA</Pill>}
          </div>

          <div className="sac-kv">
            <span>Webhook</span>
            <strong className="sac-num break-all">{webhookPath}</strong>
          </div>
          {redirectPath ? (
            <div className="sac-kv">
              <span>Redirect URI</span>
              <strong className="sac-num break-all">{redirectPath}</strong>
            </div>
          ) : null}

          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {isOAuth
              ? 'Ao continuar você será redirecionado ao portal do parceiro. O retorno para esta tela é automático.'
              : 'A conexão valida o refresh token junto à Amazon e já habilita o relay de e-mail aprovado.'}
          </p>
        </div>
      ) : null}

      {submitError ? <Alert title="Falha na conexão" tone="danger">{submitError}</Alert> : null}
    </Modal>
  );
}
