import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { Icon, cx, type IconName } from '@xploryng/convergencia';
import { useTheme } from '../lib/theme';
import { IconButton, MarketplaceBadge, Pill } from '../components/ui';

/**
 * Public documentation link.
 *
 * The SPA has no docs renderer; the operator-facing documentation lives in the
 * repository's `docs/` folder, so the marketing page points there. A deployment
 * can override it with `VITE_DOCS_URL` without a code change.
 */
const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() ||
  'https://github.com/xploryngDAO/IntegrAI/tree/main/docs';

/**
 * List prices mirrored from `@sac/shared` (`PLAN_MONTHLY_PRICE_BRL`). Runtime
 * values are never imported from the shared package into the browser bundle
 * (docs/UI_SPEC.md §Types), so the three numbers live here with their source.
 */
const PLAN_PRICE_BRL = { FREE: 0, PRO: 299, ENTERPRISE: 1_499 } as const;

function formatBrl(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(value);
}

function CtaLink({
  to,
  children,
  variant = 'primary',
  size = 'md',
  className,
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={cx('cv-button', `cv-button--${variant}`, `cv-button--${size}`, className)}
    >
      <span>{children}</span>
    </Link>
  );
}

function ThemeToggle(): JSX.Element {
  const { theme, toggle } = useTheme();
  return (
    <IconButton
      label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
      icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
      onClick={toggle}
    />
  );
}

const CHANNELS: {
  key: 'AMAZON' | 'MERCADO_LIVRE' | 'SHOPEE';
  title: string;
  protocol: string;
  description: string;
  bullets: string[];
}[] = [
  {
    key: 'AMAZON',
    title: 'Amazon',
    protocol: 'SP-API + Buyer-Seller Messaging',
    description:
      'Pedidos, devoluções e o relay de mensagens do Seller Central na mesma fila do restante da operação.',
    bullets: ['Mensageria oficial (relay SMTP)', 'Pedidos e devoluções', 'Tokens renovados pela API'],
  },
  {
    key: 'MERCADO_LIVRE',
    title: 'Mercado Livre',
    protocol: 'Questions, Messages e Claims',
    description:
      'Perguntas de pré-venda, conversas de pós-venda e reclamações abertas com o prazo de cada mediação visível.',
    bullets: ['Perguntas e pós-venda', 'Reclamações e mediações', 'Contexto do anúncio e do pedido'],
  },
  {
    key: 'SHOPEE',
    title: 'Shopee',
    protocol: 'Open Platform v2',
    description:
      'Chat do comprador e devoluções da Open Platform v2, com webhooks assinados e histórico completo.',
    bullets: ['Chat e devoluções', 'Webhooks com validação de assinatura', 'Catálogo e pedidos'],
  },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'chat',
    title: 'Fila única com SLA',
    body: 'Cada atendimento carrega o prazo do seu marketplace. A fila ordena por risco e estouro de SLA, não por ordem de chegada.',
  },
  {
    icon: 'spark',
    title: 'Classificação com IA',
    body: 'Pré-venda, pós-venda, reclamação, devolução ou cancelamento: o ticket já nasce tipado, com a política de resposta aplicável.',
  },
  {
    icon: 'file',
    title: 'Contexto completo',
    body: 'Pedido, cliente, itens e histórico na mesma tela. O operador responde sem abrir o painel do marketplace em outra aba.',
  },
  {
    icon: 'bolt',
    title: 'Ação real no canal',
    body: 'Responder, reembolsar, cancelar e mediar pela API oficial do canal, com registro do que foi enviado e do resultado.',
  },
];

const SECURITY: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'lock',
    title: 'Login protegido',
    body: 'JWT curto, refresh token rotativo e verificação em duas etapas (TOTP) com códigos de recuperação de uso único.',
  },
  {
    icon: 'devices',
    title: 'Sessões sob controle',
    body: 'Cada dispositivo aparece em Meu perfil e pode ser revogado individualmente, ou todos de uma vez.',
  },
  {
    icon: 'list',
    title: 'Auditoria administrativa',
    body: 'Convites, mudanças de papel, ativação de usuários e revogações ficam registrados com ator, IP e metadata.',
  },
  {
    icon: 'check',
    title: 'Direitos LGPD',
    body: 'O ADMIN exporta os dados do workspace em JSON e solicita a eliminação com dupla confirmação.',
  },
];

const PREVIEW_ROWS: { title: string; meta: string; sla: string; tone: 'ok' | 'warn' }[] = [
  { title: 'Pergunta de pré-venda', meta: 'Amazon · anúncio e prazo', sla: 'no prazo', tone: 'ok' },
  { title: 'Reclamação em mediação', meta: 'Mercado Livre · claims', sla: 'em risco', tone: 'warn' },
  { title: 'Devolução aberta', meta: 'Shopee · pós-venda', sla: 'no prazo', tone: 'ok' },
];

/**
 * Real captures shipped in `apps/web/public/product/` (copied from the
 * repository's `screenshots/` folder). They are the product itself — light
 * workspace, the same workspace in dark mode and the admin console — not
 * mockups, so the copy around them must not promise more than they show.
 */
const PRODUCT_SHOTS: {
  src: string;
  chrome: string;
  title: string;
  description: string;
  alt: string;
}[] = [
  {
    src: '/product/workspace-light.png',
    chrome: 'SAC Hub · atendimento',
    title: 'Fila unificada',
    description: 'Tema claro — fila, conversa e Cockpit 360° na mesma tela.',
    alt: 'Captura real da tela de atendimento no tema claro: fila unificada com tickets de Shopee e Mercado Livre, conversa de devolução da Shopee e o painel Cockpit 360° com pedido, cliente e rastreio.',
  },
  {
    src: '/product/workspace-dark.png',
    chrome: 'SAC Hub · atendimento',
    title: 'Modo escuro',
    description: 'A mesma operação no tema escuro, com contraste preservado.',
    alt: 'Captura real da mesma tela de atendimento no tema escuro, com a fila unificada, a conversa da Shopee e o Cockpit 360° preservando contraste e legibilidade.',
  },
  {
    src: '/product/admin.png',
    chrome: 'SAC Hub · administração',
    title: 'Administração e auditoria',
    description: 'Usuários, sessões, convites e eventos de auditoria.',
    alt: 'Captura real da área de administração: visão geral com usuários, sessões ativas, convites, contas, tickets e eventos de auditoria, além das abas de usuários, convites, sessões e logs.',
  },
];

/**
 * Public landing page (`/`) for visitors.
 *
 * Rendered by the App gate when there is no session; an authenticated operator
 * keeps landing on the queue at `/`. The header offers the two account entry
 * points (`/login` and `/signup`) and every section links to a real route or to
 * the public `/status` page — no dead anchors, no invented claims.
 *
 * Everything is styled with Convergência tokens (no product hex values), so the
 * page follows the light/dark switch owned by `ThemeRoot`.
 */
export function LandingPage(): JSX.Element {
  return (
    <div className="sac-landing">
      <header className="sac-landing__header">
        <div className="sac-landing__header-inner">
          {/* No `aria-label`: the visible wordmark and tagline already name the
              link, and an aria-label that omits them fails WCAG 2.5.3. */}
          <Link to="/" className="sac-landing__brand">
            <span className="sac-landing__brand-mark" aria-hidden="true">
              SH
            </span>
            <span className="sac-landing__brand-text">
              <span className="sac-landing__brand-name">SAC HUB</span>
              <span className="sac-landing__brand-tag">Central de atendimento omnichannel</span>
            </span>
          </Link>

          <nav className="sac-landing__nav" aria-label="Seções da página">
            <a href="#canais">Canais</a>
            <a href="#recursos">Recursos</a>
            <a href="#sso">SSO corporativo</a>
            <a href="#seguranca">Segurança</a>
            <a href="#planos">Planos</a>
            <Link to="/status">Status</Link>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              Docs
            </a>
          </nav>

          <div className="sac-landing__header-actions">
            <span className="sac-landing__theme">
              <ThemeToggle />
            </span>
            <CtaLink to="/login" variant="ghost" size="sm">
              Entrar
            </CtaLink>
            <CtaLink to="/signup" variant="primary" size="sm">
              Criar conta
            </CtaLink>
          </div>
        </div>
      </header>

      <main className="sac-landing__main">
        <section className="sac-landing__hero">
          <div className="sac-landing__container sac-landing__hero-grid">
            <div className="sac-landing__hero-copy">
              <span className="sac-landing__eyebrow">
                <Icon name="spark" size={14} /> Atendimento omnichannel com IA
              </span>
              <h1 className="sac-landing__title">
                Uma fila. Três marketplaces. Nenhum cliente sem resposta.
              </h1>
              <p className="sac-landing__lead">
                O SAC Hub centraliza mensagens, reclamações, devoluções e pedidos de Amazon,
                Mercado Livre e Shopee. A IA classifica, o SLA ordena e o operador responde com o
                contexto completo — sem alternar entre painéis.
              </p>

              <div className="sac-landing__cta">
                <CtaLink to="/signup" variant="primary" size="lg">
                  Criar conta grátis
                </CtaLink>
                <CtaLink to="/login" variant="secondary" size="lg">
                  Entrar no workspace
                </CtaLink>
              </div>

              <ul className="sac-landing__points">
                <li>
                  <Icon name="check" size={14} /> Fila unificada com SLA por canal
                </li>
                <li>
                  <Icon name="check" size={14} /> SSO com Microsoft Entra ID
                </li>
                <li>
                  <Icon name="check" size={14} /> LGPD desde o primeiro dia
                </li>
              </ul>
            </div>

            <div
              className="sac-landing__preview"
              role="img"
              aria-label="Prévia ilustrativa da fila unificada, com atendimentos dos três marketplaces e o prazo de SLA de cada canal"
            >
              <div className="sac-landing__preview-head">
                <div className="sac-landing__preview-heading">
                  <span className="sac-landing__preview-eyebrow">Fila unificada</span>
                  <strong>3 canais · um painel</strong>
                </div>
                <Pill tone="ok">Ao vivo</Pill>
              </div>

              <div className="sac-landing__preview-list">
                {PREVIEW_ROWS.map((row) => (
                  <div className="sac-landing__preview-row" key={row.title}>
                    <span className="sac-landing__preview-avatar" aria-hidden="true">
                      <Icon name="chat" size={15} />
                    </span>
                    <div className="sac-landing__preview-body">
                      <span className="sac-landing__preview-title">{row.title}</span>
                      <span className="sac-landing__preview-meta">{row.meta}</span>
                    </div>
                    <span className="sac-landing__preview-sla" data-tone={row.tone}>
                      {row.sla}
                    </span>
                  </div>
                ))}
              </div>

              <div className="sac-landing__preview-foot">
                <span className="sac-landing__preview-foot-label">
                  <Icon name="lock" size={13} /> Dados isolados por workspace
                </span>
                <span className="sac-landing__preview-foot-label">
                  <Icon name="clock" size={13} /> SLA por canal
                </span>
              </div>
              <p className="sac-landing__preview-caption">Prévia ilustrativa da interface.</p>
            </div>
          </div>
        </section>

        <section id="produto" className="sac-landing__section sac-landing__section--subtle">
          <div className="sac-landing__container">
            <div className="sac-landing__section-head">
              <span className="sac-landing__eyebrow">
                <Icon name="check" size={14} /> Produto real
              </span>
              <h2>Veja o produto em uso, não em mockup.</h2>
              <p>
                As imagens abaixo são capturas da aplicação real: a fila unificada, o mesmo
                workspace no tema escuro e a administração com a trilha de auditoria. É a interface
                que você encontra depois de criar a conta.
              </p>
            </div>

            <div className="sac-landing__shots">
              {PRODUCT_SHOTS.map((shot) => (
                <figure className="sac-landing__shot" key={shot.src}>
                  <div className="sac-landing__shot-chrome" aria-hidden="true">
                    <span className="sac-landing__shot-dots">
                      <span className="sac-landing__shot-dot" />
                      <span className="sac-landing__shot-dot" />
                      <span className="sac-landing__shot-dot" />
                    </span>
                    <span className="sac-landing__shot-label">{shot.chrome}</span>
                  </div>
                  <img
                    className="sac-landing__shot-image"
                    src={shot.src}
                    alt={shot.alt}
                    width={1440}
                    height={900}
                    loading="lazy"
                    decoding="async"
                  />
                  <figcaption className="sac-landing__shot-caption">
                    <strong>{shot.title}</strong>
                    <span>{shot.description}</span>
                  </figcaption>
                </figure>
              ))}
            </div>

            <p className="sac-landing__shots-note">
              <Icon name="check" size={14} /> Capturas da aplicação real. Nenhuma imagem foi
              montada ou simulada.
            </p>
          </div>
        </section>

        <section id="canais" className="sac-landing__section">
          <div className="sac-landing__container">
            <div className="sac-landing__section-head">
              <span className="sac-landing__eyebrow">Canais</span>
              <h2>Um painel para os três marketplaces que movem o seu volume.</h2>
              <p>
                Cada canal entra por API oficial, com webhooks assinados e o mesmo modelo de ticket.
                O operador não precisa saber de onde veio a conversa para resolvê-la.
              </p>
            </div>

            <div className="sac-landing__grid sac-landing__grid--3">
              {CHANNELS.map((channel) => (
                <article className="sac-landing__card" key={channel.key}>
                  <div className="sac-landing__card-head">
                    <MarketplaceBadge marketplace={channel.key} />
                    <span className="sac-landing__card-protocol">{channel.protocol}</span>
                  </div>
                  <h3>{channel.title}</h3>
                  <p>{channel.description}</p>
                  <ul className="sac-landing__list">
                    {channel.bullets.map((bullet) => (
                      <li key={bullet}>
                        <Icon name="check" size={13} /> {bullet}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="recursos" className="sac-landing__section sac-landing__section--subtle">
          <div className="sac-landing__container">
            <div className="sac-landing__section-head">
              <span className="sac-landing__eyebrow">Recursos</span>
              <h2>Feito para a rotina real de quem atende.</h2>
              <p>
                A tela de atendimento reúne fila, conversa e o contexto do pedido. As regras de cada
                canal aparecem antes do envio, não depois do erro.
              </p>
            </div>

            <div className="sac-landing__grid sac-landing__grid--4">
              {FEATURES.map((feature) => (
                <article className="sac-landing__card sac-landing__card--compact" key={feature.title}>
                  <span className="sac-landing__icon" aria-hidden="true">
                    <Icon name={feature.icon} size={19} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="sso" className="sac-landing__section">
          <div className="sac-landing__container sac-landing__split">
            <div className="sac-landing__split-copy">
              <span className="sac-landing__eyebrow">SSO corporativo</span>
              <h2>Entre com a identidade da empresa, não com mais uma senha.</h2>
              <p>
                O login corporativo usa OpenID Connect com PKCE e <code>nonce</code>, com Microsoft
                Entra ID como provedor principal. A descoberta é feita pelo domínio do e-mail: quem
                tem SSO cai direto no IdP, quem não tem continua no login por senha.
              </p>
              <ul className="sac-landing__list sac-landing__list--roomy">
                <li>
                  <Icon name="check" size={14} /> Provisionamento JIT com mapa de grupos para papel
                </li>
                <li>
                  <Icon name="check" size={14} /> Domínios permitidos por workspace (deny-by-default)
                </li>
                <li>
                  <Icon name="check" size={14} /> <code>enforce_sso</code> opcional, com break-glass de
                  operador da plataforma
                </li>
                <li>
                  <Icon name="check" size={14} /> Também compatível com Google Workspace, Okta e OIDC
                  genérico
                </li>
              </ul>
              <div className="sac-landing__cta">
                <CtaLink to="/signup" variant="primary">
                  Criar workspace
                </CtaLink>
                <CtaLink to="/login" variant="ghost">
                  Já tenho conta
                </CtaLink>
              </div>
            </div>

            <div className="sac-landing__config" aria-label="Resumo da configuração de SSO">
              <div className="sac-landing__config-head">
                <Icon name="lock" size={17} />
                <strong>Configuração do workspace</strong>
              </div>
              <dl className="sac-landing__config-list">
                <div className="sac-kv">
                  <dt>Provedor</dt>
                  <dd>Microsoft Entra ID</dd>
                </div>
                <div className="sac-kv">
                  <dt>Protocolo</dt>
                  <dd>OIDC · PKCE S256</dd>
                </div>
                <div className="sac-kv">
                  <dt>Provisionamento</dt>
                  <dd>JIT por grupo</dd>
                </div>
                <div className="sac-kv">
                  <dt>Segredo do cliente</dt>
                  <dd>AES-256-GCM</dd>
                </div>
                <div className="sac-kv">
                  <dt>Enforcement</dt>
                  <dd>Configurável</dd>
                </div>
              </dl>
              <p className="sac-landing__config-note">
                Onde encontrar: <span className="sac-num">/settings → Autenticação corporativa</span>
                , disponível para o ADMIN do workspace.
              </p>
            </div>
          </div>
        </section>

        <section id="seguranca" className="sac-landing__section sac-landing__section--subtle">
          <div className="sac-landing__container">
            <div className="sac-landing__section-head">
              <span className="sac-landing__eyebrow">Segurança e LGPD</span>
              <h2>Controles de operação séria, sem letra miúda.</h2>
              <p>
                Segredos de marketplace e do IdP são cifrados em repouso; a API é a guarda de cada
                rota administrativa. O que o operador pode fazer depende do papel dele no workspace.
              </p>
            </div>

            <div className="sac-landing__grid sac-landing__grid--4">
              {SECURITY.map((item) => (
                <article className="sac-landing__card sac-landing__card--compact" key={item.title}>
                  <span className="sac-landing__icon" aria-hidden="true">
                    <Icon name={item.icon} size={19} />
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>

            <p className="sac-landing__fineprint">
              <Icon name="flag" size={14} /> Dados tratados conforme a LGPD. A exportação e a
              eliminação do workspace são executadas pelo ADMIN, com dupla confirmação e registro de
              auditoria.
            </p>
          </div>
        </section>

        <section id="planos" className="sac-landing__section">
          <div className="sac-landing__container">
            <div className="sac-landing__section-head">
              <span className="sac-landing__eyebrow">Planos</span>
              <h2>Comece grátis. Cresça quando a operação crescer.</h2>
              <p>
                Troque de plano sem migração: as quotas são aplicadas ao workspace e o console
                administrativo mostra o uso de cada uma.
              </p>
            </div>

            <div className="sac-landing__plans">
              <article className="sac-landing__plan">
                <div className="sac-landing__plan-head">
                  <h3>Free</h3>
                  <Pill tone="neutral">Para começar</Pill>
                </div>
                <p className="sac-landing__price">
                  <strong>{formatBrl(PLAN_PRICE_BRL.FREE)}</strong>
                  <span>para sempre</span>
                </p>
                <ul className="sac-landing__list">
                  <li>
                    <Icon name="check" size={13} /> 1 loja conectada
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Até 3 operadores
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Fila unificada e SLA
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Verificação em duas etapas
                  </li>
                </ul>
                <CtaLink to="/signup" variant="secondary" className="sac-landing__plan-cta">
                  Criar conta grátis
                </CtaLink>
              </article>

              <article className="sac-landing__plan" data-featured="true">
                <div className="sac-landing__plan-head">
                  <h3>Pro</h3>
                  <Pill tone="accent">Mais escolhido</Pill>
                </div>
                <p className="sac-landing__price">
                  <strong>{formatBrl(PLAN_PRICE_BRL.PRO)}</strong>
                  <span>/mês</span>
                </p>
                <ul className="sac-landing__list">
                  <li>
                    <Icon name="check" size={13} /> Até 10 lojas e 25 operadores
                  </li>
                  <li>
                    <Icon name="check" size={13} /> SSO corporativo (Entra ID / OIDC)
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Trilha de auditoria administrativa
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Exportação e eliminação LGPD
                  </li>
                </ul>
                <CtaLink to="/signup" variant="primary" className="sac-landing__plan-cta">
                  Assinar o Pro
                </CtaLink>
              </article>

              <article className="sac-landing__plan">
                <div className="sac-landing__plan-head">
                  <h3>Enterprise</h3>
                  <Pill tone="neutral">Sob medida</Pill>
                </div>
                <p className="sac-landing__price">
                  <strong>{formatBrl(PLAN_PRICE_BRL.ENTERPRISE)}</strong>
                  <span>/mês</span>
                </p>
                <ul className="sac-landing__list">
                  <li>
                    <Icon name="check" size={13} /> Lojas e operadores sem limite prático
                  </li>
                  <li>
                    <Icon name="check" size={13} /> SSO corporativo e auditoria
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Quotas definidas em contrato
                  </li>
                  <li>
                    <Icon name="check" size={13} /> Canais e planos por workspace
                  </li>
                </ul>
                <CtaLink to="/signup" variant="secondary" className="sac-landing__plan-cta">
                  Criar workspace
                </CtaLink>
                <p className="sac-landing__plan-note">
                  Depois do cadastro, o time comercial ajusta o contrato Enterprise.
                </p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="sac-landing__footer">
        <div className="sac-landing__container sac-landing__footer-grid">
          <div className="sac-landing__footer-brand">
            <span className="sac-landing__brand-mark" aria-hidden="true">
              SH
            </span>
            <div>
              <strong className="sac-landing__brand-name">SAC HUB</strong>
              <p className="sac-landing__footer-copy">
                Central de atendimento omnichannel para Amazon, Mercado Livre e Shopee.
              </p>
              <Pill tone="ok">LGPD</Pill>
            </div>
          </div>

          <nav className="sac-landing__footer-col" aria-label="Produto">
            <span className="sac-landing__footer-title">Produto</span>
            <a href="#canais">Canais</a>
            <a href="#recursos">Recursos</a>
            <a href="#sso">SSO corporativo</a>
            <a href="#planos">Planos</a>
          </nav>

          <nav className="sac-landing__footer-col" aria-label="Conta">
            <span className="sac-landing__footer-title">Conta</span>
            <Link to="/login">Entrar</Link>
            <Link to="/signup">Criar conta</Link>
            <Link to="/forgot-password">Redefinir senha</Link>
          </nav>

          <nav className="sac-landing__footer-col" aria-label="Confiança">
            <span className="sac-landing__footer-title">Confiança</span>
            <Link to="/status">Status dos sistemas</Link>
            <a href="#seguranca">Segurança e LGPD</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              Documentação
            </a>
          </nav>
        </div>

        <div className="sac-landing__container sac-landing__footer-bottom">
          <span>© {new Date().getFullYear()} SAC Hub · IntegrAI</span>
          <span>Feito para operações de atendimento no Brasil</span>
        </div>
      </footer>
    </div>
  );
}
