# SAC Hub — Operator workspace UI specification

> **Camada visual:** a interface foi re-fundada no **Convergência Design System**
> (`@xploryng/convergencia` v0.1.0, dependência real instalada da release). Cores,
> tipografia, raios, sombras, estados e componentes vêm do DS — fundo frio,
> papel claro, índigo, Segoe UI e temas claro/escuro. Este documento descreve
> **comportamento e conteúdo** das telas; o contrato visual, os primitives e as
> classes de layout estão em [`CONVERGENCIA_ADOPTION.md`](./CONVERGENCIA_ADOPTION.md).
> O tema escuro descrito abaixo é o modo noturno opcional, não mais o padrão.

Goal: a dense, dark, operational command centre (Single Pane of Glass) that a
support lead can screenshot for a demo without shame. Think "Linear × Zendesk ×
flight control", not "generic AI dashboard". No stock photos, no emoji rain, no
purple gradients, no glassmorphism soup.

Stack: **React 18 + TypeScript (strict) + Vite 6 + Tailwind 3.4**.
Routing: `react-router-dom` v6. State: local React state + one small
`zustand` store for the workspace data. Icons: `lucide-react`. Dates:
`date-fns` (pt-BR locale).

> **Types**: import DTO/enums **type-only** from `@sac/shared`
> (`import type { TicketDetail, Marketplace } from '@sac/shared'`). Runtime
> constants must be defined locally in `src/lib/labels.ts` — never import a
> runtime value from `@sac/shared` in the browser bundle.

---

## 1. Visual system

| Token | Value | Use |
|---|---|---|
| `bg-canvas` | `#0B0F14` | app background |
| `bg-panel` | `#11161D` | panels/cards |
| `bg-elevated` | `#161D26` | hover, composer, modals |
| `border-subtle` | `#1E2732` | 1px separators |
| `border-strong` | `#2B3644` | focused inputs |
| `text-primary` | `#E6EDF5` | body |
| `text-secondary` | `#9AA9BC` | meta |
| `text-muted` | `#66748A` | timestamps |
| `accent` | `#3B82F6` | primary actions/focus |
| `amazon` | `#FF9900` | channel badge |
| `meli` | `#F5C400` | channel badge (dark text on badge) |
| `shopee` | `#EE4D2D` | channel badge |
| `danger` | `#FF4D4F` | SLA breached, destructive |
| `warn` | `#FAAD14` | SLA at risk, policy warning |
| `ok` | `#34D399` | CRR safe, healthy |

Typography: `Inter, -apple-system, "Segoe UI", sans-serif`; IDs, order numbers,
SLA clocks and anything scannable in `"JetBrains Mono", ui-monospace`. Base 13px
/ 1.45; section titles 11px uppercase `tracking-[0.08em]` `text-muted`.
Radii: 6px cards, 4px inputs, 999px pills. Shadows: only `0 8px 24px -12px #000`
on modals. 8px spacing grid.

Tailwind: put these in `tailwind.config.js` as `colors` (`canvas`, `panel`,
`elevated`, `subtle`, `strong`, `brand` …), plus `fontFamily.sans/mono`.
Custom utilities via `@layer components` in `index.css`: `.panel`, `.pill`,
`.btn`, `.btn-primary`, `.btn-ghost`, `.input`, `.badge`, `.kbd`.

---

## 2. Shell layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TOPBAR (56px)                                                             │
│ ●AMZ ●MELI ●SHOPE  |  [Loja ▾] [Marketplace ▾]   SLA médio 4h12  |  ME ▾  │
├──────────────┬─────────────────────────────────────┬──────────────────────┤
│ QUEUE        │ CHAT                                 │ COCKPIT 360º         │
│ 360px        │ flex-1 min 520px                     │ 380px                │
│ search       │ header (buyer, protocol, SLA badge)  │ Order card           │
│ filter pills │ timeline (scroll)                    │ Customer card        │
│ ticket cards │ composer (adaptive + guardrails)     │ Tracking             │
│              │                                      │ Actions panel        │
└──────────────┴─────────────────────────────────────┴──────────────────────┘
```

- Root: `h-screen w-screen overflow-hidden bg-canvas text-primary`.
- Three independently scrolling columns (`overflow-y-auto`) inside a
  `grid grid-cols-[360px_minmax(520px,1fr)_380px]`.
- `< 1280px`: queue becomes a 64px icon rail with unread counts; cockpit
  collapses behind a "Detalhes" drawer button.
- `< 1024px`: single-column with a 3-tab switcher (Fila / Conversa / Pedido).

### Topbar
Left: product mark `SAC HUB` (mono, letterspaced) + channel health dots
(green/amber/red, tooltip with detail, click filters the queue by channel).
Middle: store selector (from `GET /accounts`), marketplace multi-filter, global
SLA average (`avgFirstResponseMinutes` formatted `4h12`), live "N na fila" chip.
Right: agent presence segmented control `Online · Pausa · Offline`
(`PUT /auth/presence`), avatar with initials, and a link to `/accounts`.

Health dots use `GET /channels/health` (poll 30 s + socket `channel:health`).

---

## 3. Left column — Unified intelligent queue

Header: search input (placeholder `Buscar pedido, CPF, nome ou protocolo…`,
`⌘K` focus), filter pills `Todos · SLA crítico · Claims/Disputas · Pré-venda ·
Não atribuídos`, and a compact stat row `Abertos 42 · Em risco 6 · Violados 2`.

Ticket card (dense, 84–96px):
- Row 1: marketplace badge (`AMZ` / `MELI` / `SHOPEE`, solid brand color or
  12% tint + brand text), type badge (`RECLAMAÇÃO`, `PÓS-VENDA`, `PRÉ-VENDA`,
  `DISPUTA N2`), right-aligned SLA countdown (`2h14` mono).
- Row 2: buyer name / nick (truncate) + short subject/preview (2 lines clamp).
- Row 3: order id mono `123-4567890-1234567`, claim icon when
  `hasActiveClaim`, unread pill, assignee avatar.
- SLA state drives the left border: `BREACHED` red + subtle pulsing dot,
  `AT_RISK` amber, else transparent. Card selected = `bg-elevated` + 2px accent
  left border.
- Countdown ticks every second from `slaDeadlineAt`; `<2h` amber, `<=0` red
  `VIOLADO`.

Empty/loading/error states: skeleton rows, and an offline banner when the API is
unreachable (erro real de conexão com instrução de recuperação).

Keyboard: `j`/`k` next/prev ticket, `/` focus search, `Esc` clear.

---

## 4. Center column — unified chat + adaptive composer

### Header (sticky)
Buyer initials avatar, name, channel badge, protocol `#SAC-<short id>`, order id
mono, claim chip `CLAIM ATIVO` (danger). Right: SLA badge with exact deadline
(`SLA 24/11 18:30 · 3h22`) and a `⋯` menu (atribuir, mudar status, resolver).
Below, when Amazon: a slim RDT notice `Dados do comprador protegidos por RDT ·
expiram em 12 dias`.

### Timeline
Messages ordered by `marketplaceCreatedAt`. Each bubble:
- Header line: direction chip (`INBOUND • Buyer-Seller Relay`,
  `OUTBOUND • Meli Claims API`, `INBOUND • Shopee Chat`, …) using
  `channelRouteUsed` + `direction`, mono timestamp, delivery status icon
  (`QUEUED` clock, `SENT` check, `READ` double check, `FAILED` alert,
  `BOUNCED_BLOCKED` slash, `MODERATION_REJECTED` shield).
- Inbound left-aligned `bg-panel`, outbound right-aligned `bg-elevated` with
  accent-tinted border; internal notes full-width amber-tinted with `NOTA`.
- Attachments as chips with download (`GET /files/signed?key=`).
- Day dividers; unread divider line where `readAt` becomes set.
- Auto-scroll to bottom on new `message:created` unless the user scrolled up
  (then show "↓ novas mensagens").

### Composer (the heart of the demo)
Shared: textarea (auto-grow 64→200px), attachment button (max 10 MB, shows
uploading state via `POST /files/upload`), send button with `⌘/Ctrl+Enter`,
character counter, and a **live policy strip** fed by debounced
`POST /tickets/:id/policy-check` (350 ms):
- `blocked` → red strip listing violations, Send disabled, violating text
  highlighted in the message preview.
- warnings → amber strip.
- clean → muted green `✓ Dentro das políticas <canal>`.

Channel-specific controls directly above the textarea:

**AMAZON** — Route banner: `Rota automática: SMTP Relay (resposta receptiva)` or
`SP-API Messaging · confirmDeliveryDetails` with a one-line reason, plus a
`Trocar` link that is informational only (server decides). Controls:
checkbox `Forçar [Important] (opt-out detectado)` (auto-checked when
`channelMetadata.buyer_opt_out`), button `✓ Finalizar sem Resposta`
(`POST /tickets/:id/close-without-response`), and an attachment hint
`Anexos via MIME · máx 10 MB`.

**MERCADO LIVRE** — If `hasActiveClaim`: yellow alert
`⚠ Chat normal bloqueado → Rota automática: API de Claims` and a radio
`(•) Comprador  ( ) Mediador Meli`. If post-sale chat is blocked without a
claim: a select `Motivo estruturado` populated from
`channelMetadata.action_guide` options. Attachment hint
`Anexos sobem antes para /messages/attachments`.

**SHOPEE** — Macro bar `/rastreio /nf /prazo /enc` (click inserts template with
`{{buyer_name}}`, `{{order_sn}}`, `{{tracking_number}}` substituted live), card
buttons `📦 Card do Pedido` and `🛍 Card do Produto` (send immediately), CRR chip
`CRR: OK ✅` / `CRR: EM RISCO ⚠️`, and the primary close action
`✓ Encerrar + Marcar Lido (Proteger CRR)`.

Sending posts `POST /tickets/:id/messages` with `Idempotency-Key` (uuid v4),
optimistically appends a `QUEUED` bubble, reconciles with the server result, and
shows a toast with the route used (`Enviado via MELI Claims API`).

---

## 5. Right column — Cockpit 360º

Cards stacked with 12px gaps:

1. **Pedido** — status pill, fulfillment (`FBA`, `FBM`, `Mercado Envios`,
   `Shopee Xpress`), total `R$ 249,90`, 1–3 item rows (thumb placeholder,
   title 2-line clamp, `SKU/ASIN/MLB` mono, qty × price), link "Ver no canal".
2. **Cliente** — initials avatar, name/ nick, anonymized e-mail, document and
   phone (only when present), shipping address lines. Amazon shows a lock chip
   `RDT · purga em 30 dias` and hides fields the server did not return.
3. **Rastreio** — carrier, tracking mono, timeline of events from
   `order.shipping`, and `[Colar Rastreio no Chat]` (inserts the tracking
   template into the composer in one click).
4. **Ações de pós-venda** (dynamic, from `GET /tickets/:id/actions`):
   - Amazon: `Confirmar Detalhes de Entrega`, `Reportar Problema Inesperado`,
     `Enviar Garantia / NF` — rendered from `allowedActions`.
   - Meli: `🔄 Autorizar Devolução`, `💸 Reembolsar Cliente`,
     `⚖️ Pedir Mediação Meli` — disabled with tooltip when not in
     `available_actions`.
   - Shopee: `Status CRR: OK ✅`, `📄 Enviar Card do Pedido`,
     `🛑 Aceitar Cancelamento`, `⚠️ Abrir Disputa de Devolução`.
   Destructive actions open a confirm dialog listing the exact API call.
5. **Histórico** — compact `ticket_events` timeline (assignments, status, SLA).

---

## 6. Account connection experience (`/accounts`)

Entry point: topbar avatar menu → "Conectar lojas" and a `+ Conectar` button.

- Page header: "Canais conectados" + helper copy.
- 3 marketplace cards always visible (Amazon / Mercado Livre / Shopee) with
  brand color accent, connection status pill (`Conectado`, `Token expirado`,
  `Desconectado`), seller/shop id, token expiry, last sync, and actions
  `Reconectar`, `Atualizar token`, `Desconectar`.
- "Conectar" opens a modal driven by `GET /accounts/connectors`
  (`ConnectorDescriptor.fields`): render text/password/url/email/select inputs,
  show `helpText`, mark required, and hide secrets behind a reveal toggle.
  - Meli / Shopee: primary button `Autorizar no <marketplace>` →
    `POST /accounts/oauth/:marketplace/start` → `window.location = authorizeUrl`.
    Show the redirect URI + webhook URL with copy buttons so the operator can
    paste them in the partner console.
  - Amazon: form for `displayName`, `sellerId`, `marketplaceSiteId`,
    `refreshToken` (password), `smtp_sender_email`, `inbound_email_route`,
    `approved_sender_domains` (comma separated) → `POST /accounts/connect`.
- Query-string outcomes: `?connected=mercadolivre` → green toast;
  `?error=invalid_state` → red toast with the code.
- Webhook URLs displayed per channel:
  `/webhooks/mercadolivre`, `/webhooks/shopee`, `/webhooks/amazon/ses`.
- Nada funciona em modo simulado: sem API/credenciais a UI reporta erro honesto.

---

## 7. Sem simulação (regra de produto)

O SAC Hub **não tem modo demonstração**. Removidos do repositório: fixtures em
memória, VITE_MOCK_MODE, fallback automático de mock, banner de demonstração e
qualquer dado sintético no banco (a coluna is_demo foi eliminada por migration).

Consequências de produto:

- Sem API no ar, a tela de login mostra erro real de conexão; sem usuário
  autenticado, nada é exibido.
- Sem loja conectada, a fila fica vazia e /accounts mostra o estado
  "Desconectado" — o sistema não inventa tickets.
- A prova de que um canal funciona é o **diagnóstico real**: 
pm run doctor,
  GET /api/v1/diagnostics e o botão *Testar conexão* em cada conector
  (token exchange + leitura autenticada, sem envio ao comprador).
- Estados de erro/vazio são explícitos e acionáveis; nunca há "dados de exemplo"
  apresentados como se fossem reais.
## 8. Quality bar

- TypeScript strict, zero `any` in components (os únicos dados são os da API).
- No layout shift when switching tickets; skeleton only on first load.
- Every interactive element: visible focus ring, `aria-label` when icon-only,
  keyboard reachable.
- Numbers/IDs use tabular-nums so the SLA clocks don't jitter.
- Portuguese (pt-BR) UI copy; code and comments in English.
- `npm run build` for the web app must pass (`tsc --noEmit && vite build`).
