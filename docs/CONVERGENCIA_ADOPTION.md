# Adoção do Convergência — SAC Hub

A interface do SAC Hub usa o **Convergência Design System** (`@xploryng/convergencia`
v0.1.0, release fixada no `package.json` do workspace web) como linguagem visual
canônica. Este documento é o contrato de implementação desta UI.

## 1. Como o DS está plugado

| Ponto | Implementação |
|---|---|
| Pacote | `apps/web/package.json` → `"@xploryng/convergencia": "https://github.com/…/v0.1.0/xploryng-convergencia-0.1.0.tgz"` (pinado por URL de release; não usar `main`) |
| CSS | `src/main.tsx` importa `@xploryng/convergencia/styles.css` **antes** de `./index.css` (tokens + primitives + temas claro/escuro) |
| Provider | `src/lib/theme.tsx` → `DesignSystemProvider theme={theme} className="sac-app"`; o `<div class="cv-root">` cobre todo o app |
| Tema | claro é a identidade padrão; escuro pelo botão da topbar, persistido em `localStorage` (`sac.hub.theme`). Portais (Dialog/Tooltip/Menu) herdam o tema via contexto do DS |
| Tokens | `tailwind.config.js` mapeia as cores/tipografia/raios/sombras para `var(--cv-*)`; **nunca** declarar hex novo no produto |
| Geometria | `src/index.css` só contém o shell de operação (`.sac-shell`, `.sac-workspace`, `.sac-panel`, `.sac-thread`, `.sac-msg`, `.sac-composer`, `.sac-ticket`, `.sac-sla`) + cores de domínio dos marketplaces |

Regras herdadas de `AGENTS.md` do DS que valem aqui:

- procurar componente → variante → composição antes de criar outro;
- tokens semânticos, sem replicar hex/sombra/raio;
- `Button` executa, `Link` navega, `Tabs` troca painéis;
- toda ação de ícone tem `label`; todo campo tem `label` persistente; erro explica como corrigir;
- uma ação principal por contexto;
- foco de 3px nunca removido; alvos de 44px no celular;
- `prefers-reduced-motion` e `forced-colors` respeitados.

## 2. Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ RAIL 88px │ TOPBAR 64px: título · saúde dos canais · SLA médio · tema ·     │
│ (nav +    │ presença · operador · atalho Canais                            │
│ badge)    ├────────────────────────────────────────────────────────────────┤
│           │ banner de demonstração (quando mock)                          │
│           ├──────────────┬────────────────────────────┬───────────────────┤
│           │ FILA 320px   │ CONVERSA (fluido)          │ COCKPIT 310px     │
│           │ .sac-panel   │ .sac-panel                 │ .sac-panel        │
│           │ sac-queue-   │ sac-chat-panel             │ sac-inspector-    │
│           │ panel        │                            │ panel             │
└───────────┴──────────────┴────────────────────────────┴───────────────────┘
```

- `src/pages/WorkspacePage.tsx` monta `<QueueColumn/> <ChatPanel/> <Cockpit/>`
  dentro de `.sac-workspace` (grid). **Cada coluna renderiza sua própria
  `<section className="sac-panel …">`** — as classes de coluna são obrigatórias:
  - `sac-panel sac-queue-panel`
  - `sac-panel sac-chat-panel`
  - `sac-panel sac-inspector-panel`
- Abaixo de 1180px o inspetor some; abaixo de 900px o `.sac-mobile-view` da
  `WorkspacePage` escolhe qual painel aparece via `data-view`. Os três painéis
  permanecem montados (nunca duplicar fetch por causa de breakpoint).
- Dentro de painéis: `.sac-panel__head` (título + ações), `.sac-scroll` para a
  área rolável, `.sac-pad` para respiro de 16px.

## 3. Kit de UI do produto (`src/components/ui`)

Todos os primitives embrulham o DS e mantêm a acessibilidade dele. Importar
sempre de `../ui` (nunca do pacote direto, exceto `Icon`/`cx`/`useTheme`).

```tsx
<Button variant="primary|secondary|ghost|danger" size="sm|md|lg" loading icon={IconName|ReactNode} fullWidth />
<IconButton label icon={IconName|ReactNode} variant? size? onClick? disabled? />
<Pill tone="neutral|info|ok|warn|danger|accent|rose" />
<MarketplaceBadge marketplace compact? />      // AMZ=warning, MELI=accent, SHOPEE=rose
<TypeBadge ticketType forceCritical? />
<SlaClock deadline withDot? prefix? />         // pílula mono com tom ok/warn/danger + pulso
<Card title? subtitle? actions? footer? padded? />
<Modal open onClose title description footer? />
<ConfirmDialog open title description confirmLabel tone? loading? onConfirm onClose />
<Input label hint? error? …inputProps />       // label persistente
<Textarea label hint? error? autoGrow? />
<Select label hint? error? options />
<Toggle checked onChange label />
<SearchField label? value onChange placeholder? />
<Tooltip label><button/></Tooltip>
<Avatar name size src? />
<EmptyState title description icon? action? />
<Alert title tone="accent|success|warning|danger|rose">{texto}</Alert>
<SegmentedControl label options value onChange />
<Skeleton className? /> <Spinner label? /> <Kbd>j</Kbd>
```

Ícones: `import { Icon } from '@xploryng/convergencia'` para navegação/brand
(`chat`, `network`, `users`, `search`, `clock`, `lock`, `check`, `close`,
`arrow`, `chevron`, `down`, `spark`, `file`, `chart`, `sliders`, `sun`, `bell`,
`pulse`, `flag`, `tool`, `plus`, `list`, `grid`). Ícones de feature (clipe,
enviar, raio, filtro) podem usar `lucide-react` a 16–18px — a mistura é
intencional: DS para a linguagem, lucide para glifos utilitários.

## 4. Tipografia e densidade

- base `var(--cv-font-body)` (14px), metadados `--cv-font-meta` (12px),
  micro `--cv-font-micro` (10px) só para rótulos e decoração.
- IDs, pedidos, protocolos, cronômetros e valores monetários em `.sac-num`
  (mono + tabular-nums).
- Títulos de painel 16px semibold; título de página 22–28px.
- Respiro: 16px entre painéis/cartões, 12–14px internos, 8px entre controles.

## 5. Cores de domínio (exceções permitidas)

Marketplaces usam as **famílias de tom do DS**, não hex de marca:

| Canal | Tom | Classe |
|---|---|---|
| Amazon | warning | `.sac-market--amazon` |
| Mercado Livre | accent | `.sac-market--meli` |
| Shopee | rose | `.sac-market--shopee` |

SLA: `success` (ok) → `warning` (≤ warning window) → `danger` (violado).
Ações destrutivas (`refund`, `dispute`, `cancelar`) são `danger`; a ação
principal do composer é sempre `primary` e única.

## 6. Contratos por coluna

### Fila (`components/queue`)
- `QueueColumn` = `<section className="sac-panel sac-queue-panel">` com
  `.sac-panel__head` (título “Fila unificada” + contagem + ordenação),
  `.sac-queue__tools` (`SearchField` + `SegmentedControl` de filtros),
  `.sac-queue__stats` (4 `.sac-stat`), `.sac-scroll` com
  `<ul className="sac-ticket-list">` de `TicketCard`.
- `TicketCard` = `<li><button className="sac-ticket" aria-current=…>` com
  linha de badges (`MarketplaceBadge`, `TypeBadge`), `SlaClock`, nome do
  comprador, preview 2 linhas (`.sac-ticket__preview`), meta mono
  (pedido/claim/unread/avatar).
- Atalhos `j`/`k` e `/` preservados; skeletons no primeiro carregamento;
  empty state com `EmptyState`.

### Conversa (`components/chat`)
- Header no `.sac-panel__head`: `Avatar`, nome, `MarketplaceBadge`, `TypeBadge`,
  chip `CLAIM ATIVO`, protocolo `.sac-num`, `SlaClock`, menu de ações
  (`DropdownMenu` do DS ou `IconButton` + `Modal`).
- Timeline `.sac-scroll` → `.sac-thread`: divisores de dia `.sac-daydiv`,
  mensagens `.sac-msg` + modificadores (`--in`, `--out`, `--mediator`,
  `--system`, `--note`), meta com rota (`ROUTE_LABEL`), hora mono, ícone de
  entrega, anexos `.sac-msg__file`. Ordenação sempre por
  `marketplaceCreatedAt`.
- Composer `.sac-composer`:
  - `Amazon`: `.sac-composer__route` (rota automática + motivo), `Toggle`
    `[Important]`, `Button` “Finalizar sem resposta”, hint de anexos MIME.
  - `Meli`: `Alert tone="warning"` de chat bloqueado por claim, `RadioGroup`
    comprador/mediador, `Select` de motivo estruturado (`action_guide`).
  - `Shopee`: `.sac-macros` com `Pill`/`Button` sm (`/rastreio`, `/nf`, `/prazo`,
    `/enc`), cards de pedido/produto, chip CRR e `Button` primary
    “Encerrar + marcar lido (proteger CRR)”.
  - Guardrail em tempo real: `.sac-composer__policy` com tom danger/warning/
    success, lista de violações e botão Enviar desabilitado quando `blocked`.
  - Anexos: `FileUpload` do DS ou botão de clipe + chips; 10MB; upload pela API.
  - Envio com `Idempotency-Key` (já no store), otimista + toast com rota usada.

### Cockpit (`components/cockpit`)
- `<section className="sac-panel sac-inspector-panel">` com
  `<div className="sac-cockpit">` e cartões `Card`:
  Pedido (status, fulfillment, total, itens `.sac-item-row`), Cliente
  (avatar, e-mail anonimizado, documento/telefone mascarados, endereço,
  `Alert` de RDT no Amazon), Rastreio (`.sac-num` + `Timeline` + botão
  “Colar rastreio no chat”), Ações de pós-venda (`Button`s gerados por canal,
  destrutivas em `danger` + `ConfirmDialog`), Histórico (`Timeline`).

### Canais (`pages/AccountsPage` + `components/accounts`)
- `PageHeader` do DS + `Grid` (`min={300}`) de `Card`s por marketplace com
  `Status`/`Pill`, IDs em `.sac-num`, expiração, `Toolbar` de ações
  (`Reconectar`, `Atualizar token`, `Desconectar` com `ConfirmDialog`).
- `ConnectModal` = `Modal` com `Stepper` (Identificação → Autorização →
  Confirmação) dirigido por `api.connectors()`; OAuth com `Button primary`
  “Autorizar no <marketplace>”; Amazon com `FieldRow` de credenciais;
  URLs de webhook/redirect com `IconButton` de copiar.

## 7. Estados

- Carregando: `Skeleton` no lugar do conteúdo (sem salto de layout).
- Vazio: `EmptyState` com explicação contextual e ação.
- Erro: `Alert tone="danger"` + instrução de recuperação; nunca só cor.
- Offline/demonstração: banner global (já implementado no shell).
- Foco visível em tudo que é interativo; `aria-live` para toasts/política.

## 8. Lista de arquivos e responsáveis

| Responsável | Arquivos |
|---|---|
| Lead | `main.tsx`, `App.tsx`, `lib/theme.tsx`, `index.css`, `tailwind.config.js`, `components/ui/**`, `components/layout/**`, `pages/WorkspacePage.tsx`, `pages/LoginPage.tsx`, `index.html` |
| Agente fila | `components/queue/**` |
| Agente conversa | `components/chat/**` |
| Agente cockpit/canais | `components/cockpit/**`, `components/accounts/**`, `pages/AccountsPage.tsx` |

Não alterar o DS instalado (`node_modules`), `packages/shared`, `lib/api.ts`,
`lib/store.ts`, `lib/mock/**`, `lib/labels.ts`. Toda a lógica de negócio
(roteamento, policy-check, ações, CRR, anexos) deve ser preservada — esta
migração é de **interface**.

## 9. Verificação

```bash
npx tsc -p apps/web/tsconfig.json --noEmit
npm run build --workspace @sac/web
```

Critérios: build limpo; as três colunas em 1440px e 1280px; tema claro e escuro;
mobile em 390px com o seletor de painel; foco por teclado; composer Amazon
bloqueando link externo; alerta de claim do Meli; macros e CRR da Shopee.
