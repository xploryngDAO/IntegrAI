import type { CustomerView, TicketListItem } from '@sac/shared';
import { cx } from '@xploryng/convergencia';
import { Lock, MapPin } from 'lucide-react';
import { Alert, Avatar, Card, Pill } from '../ui';

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function shippingAddressLines(address: Record<string, unknown> | null): string[] {
  if (!address) return [];
  const street = pickString(address, ['street', 'addressLine1', 'line1', 'address', 'logradouro']);
  const number = pickString(address, ['number', 'numero', 'streetNumber']);
  const complement = pickString(address, ['complement', 'complemento', 'addressLine2', 'line2']);
  const district = pickString(address, ['district', 'neighborhood', 'bairro']);
  const city = pickString(address, ['city', 'cidade', 'municipality']);
  const state = pickString(address, ['state', 'uf', 'stateCode']);
  const postalCode = pickString(address, ['postalCode', 'zipCode', 'cep', 'zip']);
  const country = pickString(address, ['country', 'pais']);

  const lines: string[] = [];
  const lineOne = [street, number].filter(Boolean).join(', ');
  if (lineOne) lines.push(lineOne);
  if (complement) lines.push(complement);
  if (district) lines.push(district);
  const cityState = [city, state].filter(Boolean).join(' · ');
  if (cityState) lines.push(cityState);
  if (postalCode) lines.push(`CEP ${postalCode}`);
  if (country) lines.push(country);
  return lines;
}

function maskEmailAddress(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/** Defensive masking: never render a full document even if the payload leaks one. */
function maskDocument(value: string): string {
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) return `***.***.***-${digits.slice(-2)}`;
  if (digits.length > 4) return `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
  return '•••';
}

/** Defensive masking: phone keeps only area code and last two digits. */
function maskPhone(value: string): string {
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 10) return `(${digits.slice(0, 2)}) *****-**${digits.slice(-2)}`;
  return '•••';
}

interface CustomerCardProps {
  customer: CustomerView;
  ticket: TicketListItem;
  className?: string;
}

/** Cockpit card 2 — buyer identity with RDT/PII gating for Amazon. */
export function CustomerCard({ customer, ticket, className }: CustomerCardProps) {
  const displayName = customer.displayName ?? ticket.buyerDisplayName ?? 'Comprador não identificado';
  // RDT is an Amazon-only protection; other channels never show the lock notice.
  const rdtProtected =
    ticket.marketplace === 'AMAZON' && customer.piiProtection === 'RDT_30D_PURGE';
  const email = customer.anonymizedEmail ?? (customer.email ? maskEmailAddress(customer.email) : null);
  const document = customer.document ? maskDocument(customer.document) : null;
  const phone = customer.phone ? maskPhone(customer.phone) : null;
  const addressLines = shippingAddressLines(customer.shippingAddress);

  return (
    <Card
      title="Cliente"
      actions={
        rdtProtected ? (
          <Pill tone="warn">RDT · purga 30d</Pill>
        ) : (
          <Pill tone="neutral">Standard</Pill>
        )
      }
      className={cx('flex flex-col', className)}
      style={{ gap: 10 }}
    >
      <div className="sac-row min-w-0" style={{ gap: 10 }}>
        <Avatar name={displayName} size="md" />
        <div className="sac-col min-w-0">
          <strong className="truncate" title={displayName}>
            {displayName}
          </strong>
          {email ? (
            <span className="sac-num min-w-0 truncate" title={email}>
              {email}
            </span>
          ) : null}
        </div>
      </div>

      {rdtProtected ? (
        <Alert title="Dados protegidos por RDT" tone="warning">
          Comprador liberado por Restricted Data Token; os dados são expurgados automaticamente
          30 dias após o envio. Campos não retornados pelo canal permanecem ocultos.
        </Alert>
      ) : null}

      {customer.externalId ? (
        <div className="sac-kv min-w-0">
          <span>ID do comprador</span>
          <strong className="sac-num min-w-0 truncate" title={customer.externalId}>
            {customer.externalId}
          </strong>
        </div>
      ) : null}
      {document ? (
        <div className="sac-kv min-w-0">
          <span>Documento</span>
          <strong className="sac-num min-w-0 truncate" title="Documento mascarado por política de PII">
            {document}
          </strong>
        </div>
      ) : null}
      {phone ? (
        <div className="sac-kv min-w-0">
          <span>Telefone</span>
          <strong className="sac-num min-w-0 truncate" title="Telefone mascarado por política de PII">
            {phone}
          </strong>
        </div>
      ) : null}

      <div className="sac-col" style={{ gap: 6 }}>
        <span className="sac-label sac-row">
          <MapPin size={12} aria-hidden="true" />
          Endereço de entrega
        </span>
        {addressLines.length > 0 ? (
          <address className="m-0 flex flex-col gap-[2px] not-italic text-[var(--cv-font-meta)] text-[var(--cv-color-text)]">
            {addressLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </address>
        ) : (
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            {rdtProtected
              ? 'Endereço restrito não retornado pelo canal (RDT).'
              : 'Endereço não disponível para este atendimento.'}
          </p>
        )}
      </div>

      {rdtProtected ? (
        <p className="m-0 sac-row text-[var(--cv-font-micro)] text-[var(--cv-color-warning)]">
          <Lock size={12} aria-hidden="true" />
          Acesso temporário · purga automática em 30 dias
        </p>
      ) : null}
    </Card>
  );
}
