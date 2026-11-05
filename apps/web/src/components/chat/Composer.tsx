import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Marketplace, OrderItemSnapshot, RouteDecision } from '@sac/shared';
import { CheckCheck, Package, Paperclip, Send, ShoppingBag } from 'lucide-react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import {
  Alert,
  Button,
  ConfirmDialog,
  IconButton,
  Kbd,
  Pill,
  Select,
  Toggle,
} from '../ui';
import {
  AttachmentTray,
  MAX_ATTACHMENT_BYTES,
  type PendingAttachment,
} from './AttachmentTray';
import { MacroBar } from './MacroBar';
import { PolicyStrip } from './PolicyStrip';
import { RouteBanner } from './RouteBanner';

/* --------------------------------------------------------------------------
 * Cross-component draft bus (cockpit "Colar rastreio no chat" → composer).
 * ------------------------------------------------------------------------ */

type ComposerDraftHandler = (text: string) => void;
const draftHandlers = new Set<ComposerDraftHandler>();

/** Injects a completed draft into the mounted composer. */
export function setComposerDraft(text: string): void {
  for (const handler of draftHandlers) handler(text);
}

/** Subscribes the active composer to external draft injections. */
export function subscribeComposerDraft(handler: ComposerDraftHandler): () => void {
  draftHandlers.add(handler);
  return () => {
    draftHandlers.delete(handler);
  };
}

/* --------------------------------------------------------------------------
 * Channel metadata helpers (`Record<string, unknown>` → typed values).
 * ------------------------------------------------------------------------ */

function readBoolean(metadata: Record<string, unknown>, key: string): boolean {
  const value = metadata[key];
  return value === true || value === 'true';
}

function parseActionGuide(raw: unknown): Array<{ value: string; label: string }> {
  if (!Array.isArray(raw)) return [];
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.option_id === 'string'
          ? record.option_id
          : null;
    if (!id) continue;
    const label =
      typeof record.name === 'string'
        ? record.name
        : typeof record.label === 'string'
          ? record.label
          : id;
    options.push({ value: id, label });
  }
  return options;
}

function parseItemId(item: OrderItemSnapshot | undefined): number | null {
  if (!item) return null;
  const raw = item.itemId ?? item.mlb ?? null;
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

const MIN_TEXTAREA_HEIGHT = 64;
const MAX_TEXTAREA_HEIGHT = 200;

type Recipient = 'BUYER' | 'MEDIATOR';
type ComposerConfirm = 'close-without-response' | 'order-card' | 'item-card';

/**
 * Adaptive composer on `.sac-composer`: route banner, per-channel routing
 * controls, live policy guardrail, attachments and the single primary Send.
 */
export function Composer(): JSX.Element | null {
  const detail = useWorkspace((state) => state.detail);
  const sending = useWorkspace((state) => state.sending);
  const policy = useWorkspace((state) => state.policy);
  const checkPolicy = useWorkspace((state) => state.checkPolicy);
  const sendMessage = useWorkspace((state) => state.sendMessage);
  const closeWithoutResponse = useWorkspace((state) => state.closeWithoutResponse);
  const markRead = useWorkspace((state) => state.markRead);
  const pushToast = useWorkspace((state) => state.pushToast);

  const [text, setText] = useState('');
  const [recipient, setRecipient] = useState<Recipient>('BUYER');
  const [forceImportant, setForceImportant] = useState(false);
  const [meliReasonId, setMeliReasonId] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [confirm, setConfirm] = useState<ComposerConfirm | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ticketId = detail?.ticket.id ?? null;
  const ticketIdRef = useRef<string | null>(null);
  ticketIdRef.current = ticketId;

  // Reset the draft whenever the operator switches tickets.
  useEffect(() => {
    setText('');
    setAttachments([]);
    setMeliReasonId('');
    setConfirm(null);
    setRecipient(detail?.routing.recipient ?? 'BUYER');
    setForceImportant(detail ? readBoolean(detail.ticket.channelMetadata, 'buyer_opt_out') : false);
    // `detail` is intentionally not a dependency: refreshing the same ticket
    // must not wipe the operator's in-progress draft.
  }, [ticketId]);

  const insertText = useCallback((value: string) => {
    setText((previous) =>
      previous.trim().length === 0 ? value : `${previous.replace(/\s+$/, '')}\n\n${value}`,
    );
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  }, []);

  useEffect(() => subscribeComposerDraft(insertText), [insertText]);

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const nextHeight = Math.min(
      MAX_TEXTAREA_HEIGHT,
      Math.max(MIN_TEXTAREA_HEIGHT, element.scrollHeight),
    );
    element.style.height = `${nextHeight}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  const completedAttachmentCount = attachments.filter((item) => item.status === 'done').length;
  const buyerOptOut = detail ? readBoolean(detail.ticket.channelMetadata, 'buyer_opt_out') : false;

  // Debounced live policy check (350 ms per docs/UI_SPEC.md §4).
  useEffect(() => {
    if (!detail) return;
    const subject = detail.ticket.subject ?? undefined;
    const ticketKey = detail.ticket.id;
    const timer = window.setTimeout(() => {
      if (ticketIdRef.current !== ticketKey) return;
      void checkPolicy({
        bodyText: text,
        subject,
        recipient,
        attachmentCount: completedAttachmentCount,
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [checkPolicy, detail, text, recipient, completedAttachmentCount]);

  const actionGuideOptions = useMemo(
    () => parseActionGuide(detail?.ticket.channelMetadata.action_guide),
    [detail],
  );
  const allowedSpapiActions = useMemo(() => {
    const raw = detail?.ticket.channelMetadata.allowed_spapi_actions;
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : null;
  }, [detail]);

  const decision = useMemo<RouteDecision | null>(() => {
    if (!detail) return null;
    if (policy) return policy.routePreview;
    const routing = detail.routing;
    return {
      route: routing.route,
      label: routing.label,
      reason: routing.reason,
      recipient: routing.recipient,
      requiresAttachmentUpload: routing.requiresAttachmentUpload,
      blocked: routing.blocked,
      blockedReason: routing.blocked ? 'Rota bloqueada para este atendimento.' : undefined,
      actionName: null,
    };
  }, [detail, policy]);

  const macroValues = useMemo(
    () => ({
      buyerName: detail?.customer.displayName ?? detail?.ticket.buyerDisplayName ?? '',
      orderSn: detail?.order?.externalOrderId ?? detail?.ticket.externalOrderId ?? '',
      trackingNumber: detail?.order?.trackingNumber ?? '',
    }),
    [detail],
  );

  if (!detail) return null;

  // Narrowed alias so handlers declared below keep the non-null type.
  const activeDetail = detail;
  const marketplace: Marketplace = activeDetail.ticket.marketplace;
  const isAmazon = marketplace === 'AMAZON';
  const isMeli = marketplace === 'MERCADO_LIVRE';
  const isShopee = marketplace === 'SHOPEE';
  const hasActiveClaim =
    activeDetail.ticket.hasActiveClaim || activeDetail.ticket.ticketType === 'CLAIM_DISPUTE';
  const blocked = policy?.blocked === true;
  const uploadsInFlight = attachments.some((item) => item.status === 'uploading');
  const hasFailedAttachment = attachments.some((item) => item.status === 'error');
  const canSend =
    text.trim().length > 0 && !blocked && !sending && !uploadsInFlight && !hasFailedAttachment;
  const actionNameAllowed =
    decision?.actionName && allowedSpapiActions
      ? allowedSpapiActions.includes(decision.actionName)
      : null;
  const orderSn = activeDetail.order?.externalOrderId ?? activeDetail.ticket.externalOrderId ?? null;
  const firstItemId = parseItemId(activeDetail.order?.items[0]);
  const showRouteBanner =
    isAmazon ||
    (isMeli && !hasActiveClaim) ||
    (isShopee && decision?.route === 'SHOPEE_RETURNS_API');
  const placeholder = isAmazon
    ? 'Responda ao comprador — a rota é definida automaticamente…'
    : isMeli
      ? hasActiveClaim
        ? 'Escreva para o comprador ou para o mediador Meli…'
        : 'Escreva a resposta no chat do Mercado Livre…'
      : 'Escreva a resposta no chat da Shopee…';

  async function handleSend(): Promise<void> {
    if (!canSend) return;
    const attachmentKeys = attachments
      .filter((item) => item.status === 'done' && item.key)
      .map((item) => item.key as string);
    try {
      // The store owns the optimistic QUEUED bubble and the "Enviado via …" toast.
      const ok = await sendMessage({
        bodyText: text,
        recipient,
        attachmentS3Keys: attachmentKeys,
        forceImportant: isAmazon ? forceImportant : undefined,
        meliActionGuideReasonId: isMeli && meliReasonId ? meliReasonId : undefined,
      });
      if (ok) {
        setText('');
        setAttachments([]);
      }
    } catch {
      // The store already surfaced the failure; keep the draft for a retry.
    }
  }

  async function handleSilentClose(): Promise<void> {
    setConfirm(null);
    await closeWithoutResponse();
  }

  async function handleShopeeClose(): Promise<void> {
    await markRead();
  }

  async function handleShopeeCard(kind: 'order' | 'item'): Promise<void> {
    setConfirm(null);
    if (kind === 'order' && !orderSn) {
      pushToast({
        tone: 'warn',
        title: 'Pedido sem order_sn',
        description: 'Não é possível enviar o card do pedido.',
      });
      return;
    }
    if (kind === 'item' && firstItemId === null) {
      pushToast({
        tone: 'warn',
        title: 'Produto sem item_id',
        description: 'Não é possível enviar o card do produto.',
      });
      return;
    }
    try {
      // Route + toast are owned by the store once the card is dispatched.
      await sendMessage(
        kind === 'order'
          ? {
              bodyText: 'Card do Pedido',
              shopeeMessageType: 'order',
              shopeeOrderCardOrderSn: orderSn ?? undefined,
            }
          : {
              bodyText: 'Card do Produto',
              shopeeMessageType: 'item',
              shopeeItemCardItemId: firstItemId ?? undefined,
            },
      );
    } catch {
      // The store already surfaced the failure.
    }
  }

  function handleFiles(fileList: FileList | null): void {
    if (!fileList || fileList.length === 0) return;
    const uploadTicketId = ticketIdRef.current;
    for (const file of Array.from(fileList)) {
      const accepted = file.type.startsWith('image/') || file.type === 'application/pdf';
      if (!accepted) {
        pushToast({
          tone: 'warn',
          title: 'Formato não aceito',
          description: `${file.name} · envie imagem ou PDF.`,
        });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        pushToast({ tone: 'danger', title: 'Anexo acima de 10 MB', description: file.name });
        continue;
      }
      const localId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setAttachments((previous) => [
        ...previous,
        { localId, fileName: file.name, mimeType: file.type, sizeBytes: file.size, status: 'uploading' },
      ]);
      void api
        .uploadFile(file)
        .then((uploaded) => {
          if (ticketIdRef.current !== uploadTicketId) return;
          setAttachments((previous) =>
            previous.map((item) =>
              item.localId === localId ? { ...item, status: 'done', key: uploaded.key } : item,
            ),
          );
        })
        .catch(() => {
          if (ticketIdRef.current !== uploadTicketId) return;
          setAttachments((previous) =>
            previous.map((item) =>
              item.localId === localId ? { ...item, status: 'error', error: 'Falha no upload' } : item,
            ),
          );
          pushToast({ tone: 'danger', title: 'Falha ao enviar anexo', description: file.name });
        });
    }
  }

  function removeAttachment(localId: string): void {
    setAttachments((previous) => previous.filter((item) => item.localId !== localId));
  }

  return (
    <div className="sac-composer max-[900px]:max-h-[42vh] max-[900px]:overflow-y-auto max-[900px]:[scrollbar-width:none] max-[900px]:[&::-webkit-scrollbar]:hidden">
      {showRouteBanner && decision ? (
        <RouteBanner
          decision={decision}
          marketplace={marketplace}
          actionNameAllowed={isAmazon ? actionNameAllowed : null}
        />
      ) : null}

      {isAmazon ? (
        <>
          <div className="sac-composer__bar">
            <Toggle
              checked={forceImportant}
              onChange={setForceImportant}
              label="Forçar [Important] (opt-out)"
            />
            <span className="sac-spacer" aria-hidden="true" />
            <Button
              variant="ghost"
              size="sm"
              icon={<CheckCheck size={16} />}
              onClick={() => setConfirm('close-without-response')}
            >
              Finalizar sem resposta
            </Button>
          </div>
          <p className="sac-label m-0 hidden sm:block">
            Anexos via MIME · máx 10 MB
            {buyerOptOut ? ' · opt-out detectado: mensagens críticas exigem a tag' : ''}
          </p>
        </>
      ) : null}

      {isMeli ? (
        <>
          {hasActiveClaim ? (
            <Alert tone="warning" title="Chat normal bloqueado — rota automática: API de Claims">
              A conversa segue pelo processo de reclamação do Mercado Livre.
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            {hasActiveClaim ? (
              <div className="flex flex-col gap-1">
                <span className="sac-label" id={`meli-recipient-label-${activeDetail.ticket.id}`}>
                  Destinatário
                </span>
                <div
                  className="flex flex-wrap items-center gap-x-4 gap-y-1"
                  role="radiogroup"
                  aria-labelledby={`meli-recipient-label-${activeDetail.ticket.id}`}
                >
                  <label className="cv-check min-h-0 items-center">
                    <input
                      type="radio"
                      name={`meli-recipient-${activeDetail.ticket.id}`}
                      value="BUYER"
                      checked={recipient === 'BUYER'}
                      onChange={() => setRecipient('BUYER')}
                    />
                    <span>Comprador</span>
                  </label>
                  <label className="cv-check min-h-0 items-center">
                    <input
                      type="radio"
                      name={`meli-recipient-${activeDetail.ticket.id}`}
                      value="MEDIATOR"
                      checked={recipient === 'MEDIATOR'}
                      onChange={() => setRecipient('MEDIATOR')}
                    />
                    <span>Mediador Meli</span>
                  </label>
                </div>
              </div>
            ) : (
              <p className="sac-label m-0 self-center">
                Sem reclamação ativa · destinatário BUYER no chat do pack.
              </p>
            )}

            {activeDetail.ticket.ticketType !== 'PRE_SALE' && actionGuideOptions.length > 0 ? (
              <div className="min-w-[220px] flex-1">
                <Select
                  label="Motivo estruturado"
                  hint="Obrigatório para pós-venda bloqueado."
                  value={meliReasonId}
                  onChange={(event) => setMeliReasonId(event.target.value)}
                  options={[{ value: '', label: 'Selecione um motivo' }, ...actionGuideOptions]}
                />
              </div>
            ) : null}
          </div>

          {activeDetail.ticket.ticketType === 'PRE_SALE' ? (
            <p className="sac-label m-0 hidden sm:block">Resposta via /answers · pré-venda não usa o chat.</p>
          ) : null}
          <p className="sac-label m-0 hidden sm:block">Anexos sobem antes para /messages/attachments</p>
        </>
      ) : null}

      {isShopee ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <MacroBar values={macroValues} onInsert={insertText} disabled={sending} />
            {activeDetail.crr ? (
              <Pill tone={activeDetail.crr.safe ? 'ok' : 'warn'} title={activeDetail.crr.label}>
                {activeDetail.crr.safe ? 'CRR: OK' : 'CRR: EM RISCO'}
              </Pill>
            ) : null}
          </div>
          <div className="sac-composer__bar min-w-0">
            <Button
              variant="secondary"
              size="sm"
              icon={<Package size={16} />}
              disabled={sending}
              onClick={() => setConfirm('order-card')}
            >
              Card do pedido
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ShoppingBag size={16} />}
              disabled={sending}
              onClick={() => setConfirm('item-card')}
            >
              Card do produto
            </Button>
          </div>
        </>
      ) : null}

      <PolicyStrip policy={policy} marketplace={marketplace} />

      <AttachmentTray items={attachments} onRemove={removeAttachment} />

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <label htmlFor="composer-message" className="sac-label">
            Mensagem
          </label>
          <span className="sac-num flex flex-none items-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            {text.length} caracteres
            <span className="hidden items-center gap-1 sm:inline-flex" aria-hidden="true">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </span>
        </div>
        <textarea
          id="composer-message"
          ref={textareaRef}
          rows={2}
          value={text}
          disabled={sending}
          aria-label="Mensagem para o comprador"
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void handleSend();
            }
          }}
          className="cv-input cv-textarea min-h-[64px] max-h-[200px] w-full min-w-0 resize-none overflow-y-auto"
        />
      </div>

      <div className="sac-composer__bar min-w-0 flex-nowrap">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          aria-label="Anexar imagem ou PDF"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <IconButton
          label="Anexar arquivo (imagem ou PDF, até 10 MB)"
          icon={<Paperclip size={17} />}
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          className="shrink-0"
        />
        <span
          className="hidden min-w-0 flex-1 truncate text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)] sm:inline"
          title="Anexos: imagem ou PDF, até 10 MB"
        >
          {attachments.length > 0
            ? `${completedAttachmentCount}/${attachments.length} anexo(s) pronto(s)`
            : 'imagem ou PDF · máx 10 MB'}
        </span>
        {uploadsInFlight ? <span className="sac-label shrink-0">enviando anexo…</span> : null}
        {isShopee ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<CheckCheck size={16} />}
            disabled={sending}
            className="shrink-0"
            title="Encerra o atendimento e protege o índice CRR marcando a conversa como lida"
            onClick={() => void handleShopeeClose()}
          >
            Encerrar + marcar lido
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          icon={<Send size={16} />}
          loading={sending}
          disabled={!canSend}
          className="shrink-0"
          onClick={() => void handleSend()}
        >
          Enviar
        </Button>
      </div>

      <ConfirmDialog
        open={confirm === 'close-without-response'}
        title="Finalizar sem responder?"
        description="A conversa será encerrada como NO_RESPONSE_NEEDED. Nenhuma mensagem será enviada ao comprador."
        confirmLabel="Finalizar sem resposta"
        tone="primary"
        onConfirm={() => void handleSilentClose()}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'order-card'}
        title="Enviar Card do Pedido?"
        description={`Um card estruturado com o pedido ${orderSn ?? '—'} será enviado imediatamente no chat Shopee, sem texto adicional.`}
        confirmLabel="Enviar card"
        tone="primary"
        onConfirm={() => void handleShopeeCard('order')}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'item-card'}
        title="Enviar Card do Produto?"
        description="Um card estruturado com o primeiro item do pedido será enviado imediatamente no chat Shopee."
        confirmLabel="Enviar card"
        tone="primary"
        onConfirm={() => void handleShopeeCard('item')}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
