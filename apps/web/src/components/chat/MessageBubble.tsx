import { useState } from 'react';
import type { AttachmentView, DeliveryStatus, MessageView } from '@sac/shared';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  Image as ImageIcon,
  MailX,
  ShieldX,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import { DELIVERY_STATUS_LABEL, DIRECTION_LABEL, ROUTE_LABEL } from '../../lib/labels';
import { formatFileSize } from '../../lib/format';

/* --------------------------------------------------------------------------
 * Plain-text rendering (no dangerouslySetInnerHTML), links clumped for
 * readability but still policy-scanned server-side.
 * ------------------------------------------------------------------------ */

const LINK_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

interface TextToken {
  value: string;
  isLink: boolean;
}

function tokenizeBody(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  const parts = text.split(LINK_PATTERN);
  parts.forEach((part, index) => {
    if (!part) return;
    tokens.push({ value: part, isLink: index % 2 === 1 });
  });
  return tokens;
}

function hrefFor(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function renderBody(text: string): JSX.Element[] {
  return tokenizeBody(text).map((token, index) => {
    if (!token.isLink) return <span key={`text-${index}`}>{token.value}</span>;
    const trailing = token.value.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = trailing ? token.value.slice(0, -trailing.length) : token.value;
    return (
      <span key={`link-${index}`}>
        <a
          href={hrefFor(url)}
          target="_blank"
          rel="noreferrer noopener"
          className="cv-link underline"
        >
          {url}
        </a>
        {trailing}
      </span>
    );
  });
}

function formatMessageTime(iso: string): string {
  try {
    return format(parseISO(iso), 'HH:mm', { locale: ptBR });
  } catch {
    return '--:--';
  }
}

const DELIVERY_ICON: Record<DeliveryStatus, JSX.Element> = {
  QUEUED: <Clock size={13} aria-hidden="true" />,
  SENT: <Check size={13} aria-hidden="true" />,
  DELIVERED: <CheckCheck size={13} aria-hidden="true" />,
  READ: <CheckCheck size={13} aria-hidden="true" />,
  FAILED: <AlertTriangle size={13} aria-hidden="true" />,
  BOUNCED_BLOCKED: <MailX size={13} aria-hidden="true" />,
  MODERATION_REJECTED: <ShieldX size={13} aria-hidden="true" />,
};

function deliveryTone(status: DeliveryStatus): string {
  switch (status) {
    case 'FAILED':
    case 'BOUNCED_BLOCKED':
      return 'var(--cv-color-danger)';
    case 'MODERATION_REJECTED':
      return 'var(--cv-color-warning)';
    case 'READ':
      return 'var(--cv-color-accent-text)';
    default:
      return 'var(--cv-color-text-muted)';
  }
}

function AttachmentGlyph({ mimeType }: { mimeType: string }): JSX.Element {
  if (mimeType.startsWith('image/')) return <ImageIcon size={13} aria-hidden="true" />;
  return <FileText size={13} aria-hidden="true" />;
}

/** Accepts either a raw storage key or an `s3://bucket/key` URI. */
function storageKeyOf(s3Uri: string): string {
  if (s3Uri.startsWith('s3://')) {
    const withoutScheme = s3Uri.slice('s3://'.length);
    const firstSlash = withoutScheme.indexOf('/');
    return firstSlash >= 0 ? withoutScheme.slice(firstSlash + 1) : withoutScheme;
  }
  return s3Uri;
}

type BubbleKind = 'in' | 'out' | 'mediator' | 'system' | 'note';

function bubbleKindOf(message: MessageView): BubbleKind {
  if (message.isInternalNote) return 'note';
  switch (message.direction) {
    case 'OUTBOUND_AGENT':
      return 'out';
    case 'OUTBOUND_SYSTEM':
      return 'system';
    case 'MEDIATOR':
      return 'mediator';
    default:
      return 'in';
  }
}

function metaLabel(message: MessageView): string {
  if (message.isInternalNote) return 'NOTA INTERNA';
  if (message.direction === 'EXTERNAL_SELLER_PANEL') {
    return `${DIRECTION_LABEL[message.direction]} · Seller Central`;
  }
  return DIRECTION_LABEL[message.direction];
}

interface MessageBubbleProps {
  message: MessageView;
}

/** One conversation bubble on `.sac-msg` with route, time, delivery and files. */
export function MessageBubble({ message }: MessageBubbleProps): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const kind = bubbleKindOf(message);
  const cardLabel =
    message.messageType === 'order'
      ? 'Card do Pedido'
      : message.messageType === 'item'
        ? 'Card do Produto'
        : null;
  const hasBody = message.bodyCleanText.trim().length > 0;
  const payloadRef =
    typeof message.contentPayload.order_sn === 'string'
      ? message.contentPayload.order_sn
      : typeof message.contentPayload.item_id === 'string' ||
          typeof message.contentPayload.item_id === 'number'
        ? String(message.contentPayload.item_id)
        : null;

  async function handleDownload(attachment: AttachmentView): Promise<void> {
    setDownloadingId(attachment.id);
    try {
      const { url } = await api.signedUrl(storageKeyOf(attachment.s3Uri));
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      pushToast({
        tone: 'danger',
        title: 'Não foi possível abrir o anexo',
        description: attachment.fileName,
      });
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <article
      className={`sac-msg sac-msg--${kind}`}
      aria-label={`Mensagem ${DIRECTION_LABEL[message.direction]}`}
    >
      <header className="sac-msg__meta">
        <strong>{metaLabel(message)}</strong>
        <span className="sac-num">{ROUTE_LABEL[message.channelRouteUsed]}</span>
        <time className="sac-num" dateTime={message.marketplaceCreatedAt}>
          {formatMessageTime(message.marketplaceCreatedAt)}
        </time>
        <span
          className="inline-flex items-center gap-0.5"
          style={{ color: deliveryTone(message.deliveryStatus) }}
          title={DELIVERY_STATUS_LABEL[message.deliveryStatus]}
        >
          {DELIVERY_ICON[message.deliveryStatus]}
          <span className="sr-only">{DELIVERY_STATUS_LABEL[message.deliveryStatus]}</span>
        </span>
        {message.direction === 'OUTBOUND_AGENT' && message.authorAgentId && !message.isInternalNote ? (
          <span>· agente</span>
        ) : null}
      </header>

      {hasBody ? (
        <div>{renderBody(message.bodyCleanText)}</div>
      ) : cardLabel ? (
        <div className="flex items-center gap-2">
          <span className="cv-badge">{cardLabel}</span>
          {payloadRef ? <span className="sac-num text-[var(--cv-font-micro)]">{payloadRef}</span> : null}
        </div>
      ) : (
        <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Mensagem sem conteúdo textual.
        </span>
      )}

      {message.attachments.length > 0 ? (
        <div className="sac-msg__attachments">
          {message.attachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => void handleDownload(attachment)}
              disabled={downloadingId === attachment.id}
              className="sac-msg__file cursor-pointer"
              aria-label={`Baixar ${attachment.fileName}`}
              title={`Baixar ${attachment.fileName}`}
            >
              <AttachmentGlyph mimeType={attachment.mimeType} />
              <span className="sac-clip max-w-[180px]">{attachment.fileName}</span>
              <span className="sac-num">{formatFileSize(attachment.sizeBytes)}</span>
              <Download size={13} aria-hidden="true" />
              {attachment.isEvidence ? <span className="sac-label">evidência</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
