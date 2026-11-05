import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Heading, PageHeader, Progress, Stepper, Text } from '@xploryng/convergencia';
import { api, ApiClientError } from '../lib/api';
import { useWorkspace } from '../lib/store';
import type { AccountRow, TenantProfile } from '../lib/types';
import {
  dismissOnboarding,
  loadTenantProfile,
  tenantDisplayName,
  type OnboardingAgent,
} from '../lib/onboarding';
import { Alert, Button, Card, EmptyState } from '../components/ui';
import { ChannelSetup } from '../components/onboarding/ChannelSetup';
import { ChannelDiagnosis } from '../components/onboarding/ChannelDiagnosis';

/**
 * Wizard steps. `current` for the Convergência `Stepper` is the zero-based index;
 * the fifth step is the completion (the tenant flag).
 */
const STEP_LABELS = [
  'Boas-vindas',
  'Conectar lojas',
  'Diagnóstico',
  'Primeiro atendimento',
  'Concluir',
] as const;

type StepIndex = 0 | 1 | 2 | 3 | 4;

const WELCOME_STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Conecte as lojas',
    detail: 'Autorize Amazon, Mercado Livre e Shopee sem copiar credenciais técnicas.',
  },
  {
    title: 'Valide os canais',
    detail: 'O diagnóstico faz chamadas reais de token e permissão em cada conta.',
  },
  {
    title: 'Atenda o primeiro comprador',
    detail: 'A fila passa a mostrar as conversas que chegam pelos webhooks dos marketplaces.',
  },
];

const DIAGNOSIS_LABEL: Record<'ok' | 'warn' | 'fail' | 'skipped', string> = {
  ok: 'OK',
  warn: 'Atenção',
  fail: 'Falha',
  skipped: 'Não verificado',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
    return error.message;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : null;
}

/**
 * `/onboarding` — Fase 2 guided setup (docs/PHASE2_ONBOARDING.md §1).
 *
 * Five steps derived from real data: `GET /accounts` for the channel state,
 * `GET /diagnostics` + `POST /accounts/:id/diagnose` for the health summary, and
 * `PATCH /tenants/me` (optional endpoint) for the completion flag. The wizard
 * never blocks the workspace: "Pular por agora" closes it without completing and
 * every step can be revisited from `/accounts`.
 */
export function OnboardingPage(): JSX.Element {
  const navigate = useNavigate();
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const systemDiagnosis = useWorkspace((state) => state.systemDiagnosis);
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const pushToast = useWorkspace((state) => state.pushToast);

  const [step, setStep] = useState<StepIndex>(0);
  const [completing, setCompleting] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const [tenantProfile, setTenantProfile] = useState<TenantProfile | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Real workspace identity for the welcome step (`GET /tenants/me`); the same
  // page-load probe the gate uses, so this adds no extra request.
  useEffect(() => {
    let active = true;
    void loadTenantProfile().then((profile) => {
      if (active) setTenantProfile(profile);
    });
    return () => {
      active = false;
    };
  }, []);

  // Each step starts at the top: the wizard is taller than a phone screen and
  // the "Continuar" button sits at the bottom, which would otherwise keep the
  // next step scrolled past its heading.
  useEffect(() => {
    if (rootRef.current) rootRef.current.scrollTop = 0;
  }, [step]);

  /**
   * Real channel state: `GET /accounts` is the only source. The result is also
   * mirrored into the store so the rest of the shell (topbar, Canais) stays in
   * sync without forcing a second boot.
   */
  useEffect(() => {
    let active = true;
    setAccountsLoading(true);
    setAccountsError(null);

    void api
      .listAccounts()
      .then((list) => {
        if (!active) return;
        setAccounts(list);
        useWorkspace.setState({ accounts: list });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAccounts([]);
        setAccountsError(errorMessage(error));
      })
      .finally(() => {
        if (active) setAccountsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [accountsAttempt]);

  const agent: OnboardingAgent | null = currentAgent;
  const tenantName = tenantProfile?.name?.trim() || (agent ? tenantDisplayName(agent) : null);
  const firstName = firstNameOf(currentAgent?.name);
  const progress = Math.round(((step + 1) / STEP_LABELS.length) * 100);
  const connectedCount = accounts.filter((account) => account.status === 'ACTIVE').length;

  const retryAccounts = useCallback((): void => {
    setAccountsAttempt((attempt) => attempt + 1);
  }, []);

  /** Leaves without completing: the wizard must not come back on its own. */
  const dismissAndLeave = useCallback((): void => {
    if (agent) dismissOnboarding(agent);
    navigate('/', { replace: true });
  }, [agent, navigate]);

  function handleSkip(): void {
    if (completing) return;
    if (agent) dismissOnboarding(agent);
    pushToast({
      tone: 'info',
      title: 'Onboarding adiado',
      description: 'Você pode refazer este guia em Canais › Primeiros passos.',
    });
    navigate('/', { replace: true });
  }

  /**
   * Completion: `PATCH /tenants/me` is optional (docs/PHASE2_ONBOARDING.md §3).
   * A 404/405 means the route is not deployed — navigate only. Any other failure
   * is surfaced without blocking the workspace, and the local dismissal is
   * always written so the wizard does not reappear by itself.
   */
  async function handleFinish(): Promise<void> {
    if (completing) return;
    setCompleting(true);

    let persisted = true;
    let failure: string | null = null;
    try {
      await api.completeOnboarding();
    } catch (error) {
      persisted = false;
      const endpointMissing =
        error instanceof ApiClientError &&
        (error.status === 404 || error.status === 405 || error.status === 501);
      if (!endpointMissing) failure = errorMessage(error);
    }

    if (agent) dismissOnboarding(agent);

    if (failure !== null) {
      pushToast({
        tone: 'warn',
        title: 'Conclusão não salva no servidor',
        description: `${failure} O guia continua disponível em Canais.`,
      });
    } else if (persisted) {
      pushToast({
        tone: 'ok',
        title: 'Onboarding concluído',
        description: 'Seu workspace está liberado para atender.',
      });
    }

    setCompleting(false);
    navigate('/', { replace: true });
  }

  function primaryAction(): void {
    if (step === 0) setStep(1);
    else if (step === 1) setStep(2);
    else if (step === 2) setStep(3);
    else if (step === 3) setStep(4);
    else void handleFinish();
  }

  const primaryLabel =
    step === 4 ? 'Concluir onboarding' : step === 0 ? 'Começar' : 'Continuar';

  const diagnosisOverall = systemDiagnosis?.overall ?? null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Onboarding"
        title="Primeiros passos"
        description="Conecte seus canais, valide as credenciais e receba o primeiro atendimento. Você pode pular a qualquer momento."
        actions={
          <Button variant="ghost" onClick={handleSkip} disabled={completing}>
            Pular por agora
          </Button>
        }
      />

      <Card aria-label={`Progresso do onboarding: passo ${step + 1} de ${STEP_LABELS.length}`}>
        <div className="flex flex-col gap-3">
          <div className="hidden sm:block">
            <Stepper steps={[...STEP_LABELS]} current={step} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:hidden">
            <span className="sac-label">Passo {step + 1} de 5</span>
            <span className="text-[var(--cv-font-meta)] font-medium">{STEP_LABELS[step]}</span>
          </div>
          <Progress value={progress} label="Progresso do onboarding" />
        </div>
      </Card>

      {step === 0 ? (
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="sac-label">Boas-vindas</span>
              <Heading level={2}>
                {firstName ? `Olá, ${firstName}.` : 'Boas-vindas ao SAC Hub.'} Vamos colocar sua
                operação no ar.
              </Heading>
              <Text muted as="p">
                {tenantName ? (
                  <>
                    Tudo o que você configurar aqui vale para <strong>{tenantName}</strong>.
                  </>
                ) : (
                  'Tudo o que você configurar aqui vale para o seu workspace.'
                )}{' '}
                São cinco passos curtos e nenhum passo exige credencial técnica.
              </Text>
            </div>

            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {WELCOME_STEPS.map((entry, index) => (
                <li key={entry.title} className="flex items-start gap-2.5">
                  <span className="sac-num flex h-6 w-6 flex-none items-center justify-center rounded-[var(--cv-radius-pill)] bg-[var(--cv-color-accent-soft)] text-[var(--cv-font-micro)] font-semibold text-[var(--cv-color-accent-text)]">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <strong className="block text-[var(--cv-font-control)] font-medium">
                      {entry.title}
                    </strong>
                    <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
                      {entry.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <Alert title="Sem dados simulados" tone="neutral">
              A fila só mostra atendimentos que chegam de verdade pelos webhooks dos marketplaces.
              Nada é preenchido com exemplo.
            </Alert>
          </div>
        </Card>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2}>Conecte suas lojas</Heading>
            <Text muted as="p">
              Autorize cada canal no portal do marketplace. Você pode conectar uma agora e as demais
              depois, em Canais.
            </Text>
          </div>
          <ChannelSetup
            accounts={accounts}
            loading={accountsLoading}
            error={accountsError}
            onRetry={retryAccounts}
          />
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2}>Diagnóstico dos canais</Heading>
            <Text muted as="p">
              Confirme que os tokens e as permissões de cada loja estão válidos antes de operar. O
              teste é somente leitura.
            </Text>
          </div>
          <ChannelDiagnosis accounts={accounts} />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2}>Seu primeiro atendimento</Heading>
            <Text muted as="p">
              A fila fica vazia até o primeiro evento real chegar de um marketplace. Não há conversa
              de exemplo — o primeiro ticket aparece quando um comprador escrever.
            </Text>
          </div>

          {totalTickets > 0 ? (
            <Alert title="Sua fila já tem atendimentos" tone="success">
              Existem {totalTickets} atendimento(s) na fila. Abra o workspace para responder com o
              roteamento e a política de cada canal.
            </Alert>
          ) : (
            <EmptyState
              title="A fila começa vazia"
              description="Assim que o webhook de um canal conectado receber a primeira mensagem, o atendimento entra na fila com SLA e histórico do pedido."
              icon="chat"
            />
          )}

          <Card title="O que precisa acontecer">
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-4 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              <li>
                A loja está conectada e o webhook do marketplace aponta para este workspace.
              </li>
              <li>
                O comprador envia a primeira mensagem ou abre uma reclamação no pedido.
              </li>
              <li>
                O atendimento aparece na <strong className="text-[var(--cv-color-text)]">Fila</strong>{' '}
                com tipo, SLA e rota de resposta já resolvidos.
              </li>
            </ol>

            <div className="sac-divider" />

            <p className="sac-label m-0">Guia de teste</p>
            <p className="m-0 mt-1 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Os cenários de validação estão documentados em{' '}
              <span className="sac-num">docs/TEST_SCENARIOS.md</span> (documento do repositório,
              consultado pelo time técnico).
            </p>
          </Card>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2}>Concluir onboarding</Heading>
            <Text muted as="p">
              Vamos registrar a conclusão e abrir a fila de atendimento. Você pode refazer este guia
              em Canais › Primeiros passos quando quiser.
            </Text>
          </div>

          <Card title="Resumo do workspace">
            <dl className="m-0 flex flex-col gap-1.5">
              <div className="sac-kv">
                <span>Lojas conectadas</span>
                <strong className="sac-num">
                  {connectedCount} de {accounts.length}
                </strong>
              </div>
              <div className="sac-kv">
                <span>Diagnóstico</span>
                <strong>
                  {diagnosisOverall !== null ? DIAGNOSIS_LABEL[diagnosisOverall] : 'Não executado'}
                </strong>
              </div>
              <div className="sac-kv">
                <span>Fila</span>
                <strong>
                  {totalTickets > 0 ? `${totalTickets} atendimento(s)` : 'Aguardando evento real'}
                </strong>
              </div>
            </dl>

            {accounts.length === 0 ? (
              <div className="mt-3">
                <Alert title="Nenhuma loja conectada" tone="warning">
                  Você pode concluir mesmo assim, mas a fila só recebe atendimentos depois de
                  conectar ao menos um canal em Canais.
                </Alert>
              </div>
            ) : null}
          </Card>

          <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            O guia não bloqueia o workspace: se você concluir sem conectar uma loja, a fila apenas
            continua vazia até o primeiro canal ser autorizado em Canais.
          </p>
        </div>
      ) : null}

      {/* Sticky on purpose: on a 390px screen the step body scrolls and the
          primary action must stay reachable without hunting for it. */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--cv-color-border)] bg-[var(--cv-color-background)] pb-1 pt-3">
        <Button
          variant="ghost"
          disabled={step === 0 || completing}
          onClick={() => setStep((current) => (current === 0 ? 0 : ((current - 1) as StepIndex)))}
        >
          Voltar
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {/* The workspace is always one click away — leaving does not complete
              the wizard, it only records the local dismissal. */}
          {step === 3 ? (
            <Button variant="secondary" icon="arrow" onClick={dismissAndLeave}>
              Ir para o workspace
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={step === 4 ? 'check' : 'arrow'}
            loading={completing}
            onClick={primaryAction}
          >
            {primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
