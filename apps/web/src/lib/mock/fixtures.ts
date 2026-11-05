/**
 * Demo fixtures for mock mode (docs/UI_SPEC.md §7).
 *
 * Everything is typed against the `@sac/shared` DTOs. Deadlines are generated
 * relative to module load so the demo always shows a live breach, an at-risk
 * ticket, a ~2h ticket, a ~18h ticket and a comfortable one.
 */
import type {
  AccountStatus,
  AttachmentView,
  AvailableActionView,
  ChannelHealthView,
  ChannelRoute,
  ConnectorDescriptor,
  CrrStatusView,
  CustomerView,
  DeliveryStatus,
  IAgentSummary,
  Marketplace,
  MessageDirection,
  MessageView,
  OrderItemSnapshot,
  OrderView,
  RoutePreview,
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '@sac/shared';

import type { AccountRow } from '../types';

/* ==========================================================================
 * Relativistic time helpers
 * ========================================================================== */

const NOW = Date.now();
const HOUR = 3_600_000;

function isoIn(hours: number): string {
  return new Date(NOW + hours * HOUR).toISOString();
}

function isoAgo(hours: number): string {
  return isoIn(-hours);
}

function daysAgo(days: number): string {
  return isoIn(-days * 24);
}

/* ==========================================================================
 * Small builders
 * ========================================================================== */

export function attachment(
  id: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
): AttachmentView {
  return {
    id,
    fileName,
    mimeType,
    sizeBytes,
    s3Uri: `s3://sac-hub-attachments/demo/${id}/${fileName}`,
    isEvidence: false,
    downloadUrl: null,
  };
}

interface MessageInput {
  id: string;
  direction: MessageDirection;
  route: ChannelRoute;
  at: string;
  text: string;
  deliveryStatus?: DeliveryStatus;
  isInternalNote?: boolean;
  authorAgentId?: string | null;
  attachments?: AttachmentView[];
  contentPayload?: Record<string, unknown>;
  messageType?: string;
}

function message(input: MessageInput): MessageView {
  const inbound = input.direction === 'INBOUND_BUYER' || input.direction === 'MEDIATOR';
  return {
    id: input.id,
    externalMessageId: `ext-${input.id}`,
    direction: input.direction,
    channelRouteUsed: input.route,
    messageType: input.messageType ?? 'text',
    bodyCleanText: input.text,
    bodyHtml: null,
    deliveryStatus: input.deliveryStatus ?? (inbound ? 'DELIVERED' : 'SENT'),
    isInternalNote: input.isInternalNote ?? false,
    authorAgentId: input.authorAgentId ?? null,
    marketplaceCreatedAt: input.at,
    attachments: input.attachments ?? [],
    contentPayload: input.contentPayload ?? {},
  };
}

type TicketEvent = TicketDetail['events'][number];

function event(
  id: string,
  eventType: string,
  actorLabel: string | null,
  at: string,
  payload: Record<string, unknown> = {},
): TicketEvent {
  return { id, eventType, actorLabel, payload, createdAt: at };
}

function item(input: OrderItemSnapshot): OrderItemSnapshot {
  return input;
}

/* ==========================================================================
 * Agents
 * ========================================================================== */

export const mockAgents: IAgentSummary[] = [
  {
    id: 'a-1',
    name: 'Ana Ribeiro',
    email: 'ana.ribeiro@sachub.app',
    role: 'SUPERVISOR',
    presence: 'ONLINE',
    avatarColor: '#3B82F6',
    activeTickets: 4,
  },
  {
    id: 'a-2',
    name: 'Bruno Carvalho',
    email: 'bruno.carvalho@sachub.app',
    role: 'AGENT',
    presence: 'ONLINE',
    avatarColor: '#34D399',
    activeTickets: 3,
  },
  {
    id: 'a-3',
    name: 'Camila Duarte',
    email: 'camila.duarte@sachub.app',
    role: 'AGENT',
    presence: 'PAUSED',
    avatarColor: '#F5C400',
    activeTickets: 2,
  },
  {
    id: 'a-4',
    name: 'Diego Martins',
    email: 'diego.martins@sachub.app',
    role: 'AGENT',
    presence: 'OFFLINE',
    avatarColor: '#EE4D2D',
    activeTickets: 0,
  },
  {
    id: 'a-5',
    name: 'Elisa Fontes',
    email: 'elisa.fontes@sachub.app',
    role: 'AGENT',
    presence: 'OFFLINE',
    avatarColor: '#A78BFA',
    activeTickets: 0,
  },
];

export const mockAgentsOnline: IAgentSummary[] = mockAgents.filter(
  (agent) => agent.presence === 'ONLINE',
);

/** Demo agent signed in when mock mode boots (no login wall). */
export const mockCurrentAgent: IAgentSummary = mockAgents[0];

/* ==========================================================================
 * Accounts
 * ========================================================================== */

export const mockAccounts: AccountRow[] = [
  {
    id: 'acc-amz-001',
    marketplace: 'AMAZON',
    displayName: 'Amazon BR · Minha Marca',
    externalSellerId: 'A2Q3Y263D00KWC',
    marketplaceSiteId: 'A2Q3Y263D00KWC',
    status: 'ACTIVE',
    channelConfig: {
      smtp_sender_email: 'atendimento@minhamarca.com.br',
      inbound_email_route: 'amazon-relay@inbound.sachub.app',
      approved_sender_domains: ['minhamarca.com.br'],
    },
    tokenExpiresAt: isoIn(24 * 50),
    authExpiresAt: isoIn(24 * 300),
  },
  {
    id: 'acc-meli-001',
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Mercado Livre · Minha Marca Oficial',
    externalSellerId: '184729301',
    marketplaceSiteId: 'MLB',
    status: 'ACTIVE',
    channelConfig: {
      site_id: 'MLB',
      nickname: 'MINHAMARCAOFICIAL',
      autoreply_enabled: false,
    },
    tokenExpiresAt: isoIn(5.8),
    authExpiresAt: isoIn(24 * 180),
  },
  {
    id: 'acc-shopee-001',
    marketplace: 'SHOPEE',
    displayName: 'Shopee · Minha Marca BR',
    externalSellerId: 'shop-8842197',
    marketplaceSiteId: '8842197',
    status: 'TOKEN_EXPIRED',
    channelConfig: {
      shop_id: '8842197',
      region: 'BR',
      crr_target_hours: 12,
    },
    tokenExpiresAt: isoIn(0.68),
    authExpiresAt: isoIn(24 * 30),
  },
];

/* ==========================================================================
 * Connector descriptors (drives the /accounts connect wizard)
 * ========================================================================== */

export const mockConnectors: ConnectorDescriptor[] = [
  {
    marketplace: 'AMAZON',
    authMode: 'HYBRID',
    fields: [
      {
        key: 'displayName',
        label: 'Nome da loja',
        type: 'text',
        required: true,
        placeholder: 'Amazon BR · Minha Marca',
        helpText: 'Nome interno exibido no seletor de lojas.',
      },
      {
        key: 'externalSellerId',
        label: 'Seller ID',
        type: 'text',
        required: true,
        placeholder: 'A2Q3Y263D00KWC',
        helpText: 'Seller Central → Configurações → Informações da conta.',
      },
      {
        key: 'marketplaceSiteId',
        label: 'Marketplace Site ID',
        type: 'select',
        required: true,
        options: [
          { value: 'A2Q3Y263D00KWC', label: 'Amazon.com.br (A2Q3Y263D00KWC)' },
          { value: 'ATVPDKIKX0DER', label: 'Amazon.com (ATVPDKIKX0DER)' },
          { value: 'A1AM78C64UM0Y8', label: 'Amazon.com.mx (A1AM78C64UM0Y8)' },
        ],
      },
      {
        key: 'refreshToken',
        label: 'LWA Refresh Token',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'Atzr|…',
        helpText: 'Gerado no Seller Central após autorizar o app SP-API.',
      },
      {
        key: 'smtp_sender_email',
        label: 'E-mail remetente aprovado',
        type: 'email',
        required: true,
        placeholder: 'atendimento@minhamarca.com.br',
        helpText: 'Verificado no Seller Central · usado no Relay SMTP (Route 1).',
      },
      {
        key: 'inbound_email_route',
        label: 'Rota de entrada SES',
        type: 'text',
        required: true,
        placeholder: 'amazon-relay@inbound.sachub.app',
        helpText: 'Endereço que recebe as mensagens encaminhadas pela Amazon.',
      },
      {
        key: 'approved_sender_domains',
        label: 'Domínios aprovados',
        type: 'text',
        required: false,
        placeholder: 'minhamarca.com.br, minhamarca.com',
        helpText: 'Separados por vírgula. Usados na política de links.',
      },
    ],
    authorizeUrlTemplate: null,
    webhookPath: '/webhooks/amazon/ses',
    docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/messaging-api',
    notes: [
      'A Amazon exige resposta receptiva via Relay SMTP: nunca inicie contato proativo.',
      'Dados do comprador exigem Restricted Data Token e são expurgados em 30 dias.',
    ],
  },
  {
    marketplace: 'MERCADO_LIVRE',
    authMode: 'OAUTH2',
    fields: [
      {
        key: 'displayName',
        label: 'Nome da loja',
        type: 'text',
        required: true,
        placeholder: 'Mercado Livre · Minha Marca',
        helpText: 'Usado para identificar a conta no seletor.',
      },
    ],
    authorizeUrlTemplate:
      'https://auth.mercadolivre.com.br/authorization?response_type=code&client_id={{clientId}}&redirect_uri={{redirectUri}}&state={{state}}',
    webhookPath: '/webhooks/mercadolivre',
    docsUrl: 'https://developers.mercadolivre.com.br/pt_br',
    notes: [
      'O refresh token rotaciona a cada 6h — o hub renova automaticamente.',
      'Claims usam a Claims API; o chat comum fica bloqueado durante a reclamação.',
    ],
  },
  {
    marketplace: 'SHOPEE',
    authMode: 'OAUTH2',
    fields: [
      {
        key: 'displayName',
        label: 'Nome da loja',
        type: 'text',
        required: true,
        placeholder: 'Shopee · Minha Marca BR',
        helpText: 'Usado para identificar a conta no seletor.',
      },
    ],
    authorizeUrlTemplate:
      'https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id={{partnerId}}&redirect={{redirectUri}}&timestamp={{timestamp}}&sign={{sign}}',
    webhookPath: '/webhooks/shopee',
    docsUrl: 'https://open.shopee.com/documents',
    notes: [
      'Token de refresh é de uso único — renovações são serializadas por lock.',
      'CRR: responda em até 12h e garanta que a última mensagem seja sua.',
    ],
  },
];

/* ==========================================================================
 * Channel health
 * ========================================================================== */

export const mockChannelHealth: ChannelHealthView[] = [
  {
    marketplace: 'AMAZON',
    accountId: 'acc-amz-001',
    accountDisplayName: 'Amazon BR · Minha Marca',
    status: 'ACTIVE',
    inboundHealthy: true,
    outboundHealthy: true,
    tokenExpiresAt: isoIn(24 * 50),
    detail: 'SES inbound OK · Relay SMTP OK',
    crrPercent: null,
  },
  {
    marketplace: 'MERCADO_LIVRE',
    accountId: 'acc-meli-001',
    accountDisplayName: 'Mercado Livre · Minha Marca Oficial',
    status: 'ACTIVE',
    inboundHealthy: true,
    outboundHealthy: true,
    tokenExpiresAt: isoIn(5.8),
    detail: 'Webhook OK · token renova em 5h48',
    crrPercent: null,
  },
  {
    marketplace: 'SHOPEE',
    accountId: 'acc-shopee-001',
    accountDisplayName: 'Shopee · Minha Marca BR',
    status: 'TOKEN_EXPIRED',
    inboundHealthy: true,
    outboundHealthy: false,
    tokenExpiresAt: isoIn(0.68),
    detail: 'Token expira em 41 min · renovação automática agendada',
    crrPercent: 88,
  },
];

/* ==========================================================================
 * Ticket 1 — Amazon pós-venda (delivery question, RDT)
 * ========================================================================== */

const AMZ1_ORDER_ID = '701-2234567-8899001';
const AMZ1_DEADLINE = isoIn(18.03);
const AMZ1_LAST_MESSAGE = isoAgo(0.58);

const amz1Order: OrderView = {
  externalOrderId: AMZ1_ORDER_ID,
  packId: null,
  orderStatus: 'SHIPPED',
  fulfillmentType: 'FBA',
  totalAmount: 249.9,
  currency: 'BRL',
  trackingNumber: 'TBA309218374000',
  carrierName: 'Amazon Logistics',
  items: [
    item({
      asin: 'B0CH3X9K2L',
      sku: 'MNC-CAM-PRETO-M',
      itemId: null,
      mlb: null,
      title: 'Camiseta Algodão Premium Masculina — Preta, M',
      quantity: 1,
      unitPrice: 179.9,
      imageUrl: null,
      variation: 'Preta / M',
    }),
    item({
      asin: 'B0CH3X9K3M',
      sku: 'MNC-MEIA-BRANCA-KIT3',
      itemId: null,
      mlb: null,
      title: 'Meia Esportiva Kit 3 Pares — Branca',
      quantity: 2,
      unitPrice: 35,
      imageUrl: null,
      variation: 'Branca / 39-43',
    }),
  ],
  allowedActions: {
    confirmDeliveryDetails: true,
    unexpectedProblem: true,
  },
  shipping: {
    carrier: 'Amazon Logistics',
    tracking: 'TBA309218374000',
    service: 'FBA Prime',
    events: [
      { status: 'Pedido recebido', at: isoAgo(72), location: 'Cajamar, SP' },
      { status: 'Enviado do centro logístico', at: isoAgo(48), location: 'Cajamar, SP' },
      { status: 'Em trânsito', at: isoAgo(16), location: 'Osasco, SP' },
      { status: 'Saiu para entrega', at: isoAgo(5), location: 'São Paulo, SP' },
    ],
  },
  estimatedDeliveryAt: isoIn(6),
  shippedAt: isoAgo(48),
  deliveredAt: null,
  lastSyncedAt: isoAgo(0.1),
};

const amz1Customer: CustomerView = {
  externalId: 'A3K9X2M8R7Q1L5',
  displayName: 'Mariana Alves',
  anonymizedEmail: 'm***a@marketplace.amazon.com.br',
  document: null,
  phone: null,
  email: null,
  shippingAddress: {
    line1: 'Rua das Palmeiras, 482',
    line2: 'Apto 71',
    district: 'Vila Mariana',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '04014-010',
    country: 'BR',
  },
  piiProtection: 'RDT_30D_PURGE',
  consents: {},
};

const amz1Detail: TicketDetail = {
  ticket: {
    id: 'tkt-amz-001',
    marketplace: 'AMAZON',
    accountId: 'acc-amz-001',
    accountDisplayName: 'Amazon BR · Minha Marca',
    ticketType: 'POST_SALE_ORDER',
    subject: 'Pedido atrasado — previsão de entrega',
    externalReferenceId: AMZ1_ORDER_ID,
    externalOrderId: AMZ1_ORDER_ID,
    buyerDisplayName: 'Mariana Alves',
    buyerAnonymizedEmail: 'm***a@marketplace.amazon.com.br',
    hasActiveClaim: false,
    status: 'OPEN_WAITING_AGENT',
    priority: 'HIGH',
    slaDeadlineAt: AMZ1_DEADLINE,
    slaState: 'ON_TRACK',
    slaBreached: false,
    firstResponseAt: isoAgo(2.7),
    lastMessageAt: AMZ1_LAST_MESSAGE,
    unreadCount: 2,
    assignedAgentId: 'a-1',
    assignedAgentName: 'Ana Ribeiro',
    assignedQueue: 'SAC::Amazon-N1',
    channelMetadata: {
      no_response_link: `https://sellercentral.amazon.com/messaging/no-response-needed?orderId=${AMZ1_ORDER_ID}`,
      buyer_opt_out: false,
      allowed_spapi_actions: ['confirmDeliveryDetails', 'unexpectedProblem'],
      rdt_protected: true,
      message_subject: `Re: Pedido ${AMZ1_ORDER_ID}`,
    },
    tags: ['RDT', 'PÓS-VENDA'],
    isDemo: true,
  },
  order: amz1Order,
  customer: amz1Customer,
  messages: [
    message({
      id: 'msg-amz1-1',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(3.2),
      text: 'Olá! Fiz o pedido 701-2234567-8899001 no dia 02/11 e até agora não recebi. O rastreio mostra que saiu para entrega ontem, mas não chegou nada. Pode verificar?',
      attachments: [attachment('att-amz1-1', 'foto-porta.jpg', 'image/jpeg', 184_320)],
    }),
    message({
      id: 'msg-amz1-2',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(3.1),
      text: 'Preciso do produto até sexta para uma viagem. Se não chegar até lá, vou precisar cancelar.',
    }),
    message({
      id: 'msg-amz1-3',
      direction: 'OUTBOUND_AGENT',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(2.7),
      text: 'Oi, Mariana! Tudo bem? Sou a Ana, do time de atendimento da Minha Marca. Vou acompanhar seu pedido por aqui e já aciono a transportadora para priorizar a entrega.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-1',
    }),
    message({
      id: 'msg-amz1-4',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(0.77),
      text: 'Obrigada, Ana. Consegue confirmar se sai hoje ainda?',
    }),
    message({
      id: 'msg-amz1-5',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: AMZ1_LAST_MESSAGE,
      text: 'Acabei de ligar na transportadora e ninguém atende. Estou sem retorno até agora.',
    }),
  ],
  events: [
    event('ev-amz1-1', 'TICKET_CREATED', 'Sistema', isoAgo(3.2), {
      marketplace: 'AMAZON',
      source: 'SES relay',
    }),
    event('ev-amz1-2', 'TICKET_ASSIGNED', 'Roteador automático', isoAgo(3.05), {
      agent: 'Ana Ribeiro',
    }),
    event('ev-amz1-3', 'MESSAGE_SENT', 'Ana Ribeiro', isoAgo(2.7), {
      route: 'AMAZON_EMAIL_RELAY',
    }),
    event('ev-amz1-4', 'SLA_UPDATED', 'Sistema', isoAgo(2), {
      slaDeadlineAt: AMZ1_DEADLINE,
      slaState: 'ON_TRACK',
    }),
  ],
  routing: {
    route: 'AMAZON_EMAIL_RELAY',
    label: 'Buyer-Seller Relay (SMTP)',
    reason: 'Resposta receptiva: já existe mensagem do comprador neste ticket.',
    blocked: false,
    warnings: [],
    recipient: 'BUYER',
    requiresAttachmentUpload: false,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'AMAZON_CONFIRM_DELIVERY_DETAILS',
      label: 'Confirmar Detalhes de Entrega',
      description: 'Envia a confirmação de detalhes de entrega via SP-API Messaging.',
      route: 'AMAZON_SP_API_MESSAGING',
      enabled: true,
      destructive: false,
      requiresConfirmation: false,
      source: 'allowed_spapi_actions',
    },
    {
      kind: 'AMAZON_UNEXPECTED_PROBLEM',
      label: 'Reportar Problema Inesperado',
      description: 'Reporta um problema inesperado com o pedido ao comprador.',
      route: 'AMAZON_SP_API_MESSAGING',
      enabled: true,
      destructive: false,
      requiresConfirmation: true,
      source: 'allowed_spapi_actions',
    },
    {
      kind: 'AMAZON_WARRANTY',
      label: 'Enviar Garantia / NF',
      description: 'Envia a nota fiscal e o termo de garantia como anexo.',
      route: 'AMAZON_SP_API_MESSAGING',
      enabled: false,
      destructive: false,
      requiresConfirmation: false,
      source: 'allowed_spapi_actions',
    },
    {
      kind: 'AMAZON_NO_RESPONSE_NEEDED',
      label: 'Finalizar sem Resposta',
      description: 'Marca o ticket como sem resposta necessária (Route 3, sem envio).',
      route: 'AMAZON_EMAIL_RELAY',
      enabled: true,
      destructive: true,
      requiresConfirmation: true,
      source: 'system',
    },
  ],
  crr: null,
};

/* ==========================================================================
 * Ticket 2 — Amazon pré-venda (policy-guardrail scenario)
 * ========================================================================== */

const AMZ2_DEADLINE = isoIn(1.93);
const AMZ2_LAST_MESSAGE = isoAgo(0.6);

const amz2Customer: CustomerView = {
  externalId: 'A1B2C3D4E5F6G7',
  displayName: 'Rafael Nogueira',
  anonymizedEmail: 'r***l@marketplace.amazon.com.br',
  document: null,
  phone: null,
  email: null,
  shippingAddress: null,
  piiProtection: 'STANDARD',
  consents: {},
};

const amz2Detail: TicketDetail = {
  ticket: {
    id: 'tkt-amz-002',
    marketplace: 'AMAZON',
    accountId: 'acc-amz-001',
    accountDisplayName: 'Amazon BR · Minha Marca',
    ticketType: 'PRE_SALE',
    subject: 'Dúvida sobre tamanho antes de comprar',
    externalReferenceId: 'r***l@marketplace.amazon.com.br',
    externalOrderId: null,
    buyerDisplayName: 'Rafael Nogueira',
    buyerAnonymizedEmail: 'r***l@marketplace.amazon.com.br',
    hasActiveClaim: false,
    status: 'UNREAD',
    priority: 'HIGH',
    slaDeadlineAt: AMZ2_DEADLINE,
    slaState: 'AT_RISK',
    slaBreached: false,
    firstResponseAt: isoAgo(25),
    lastMessageAt: AMZ2_LAST_MESSAGE,
    unreadCount: 2,
    assignedAgentId: null,
    assignedAgentName: null,
    assignedQueue: 'COMERCIAL::Pre-Venda',
    channelMetadata: {
      no_response_link: null,
      buyer_opt_out: false,
      allowed_spapi_actions: [],
      rdt_protected: false,
      draft_hint:
        'Teste de política: cole um link externo ou e-mail no rascunho para ver o bloqueio em tempo real.',
    },
    tags: ['PRÉ-VENDA', 'NÃO ATRIBUÍDO'],
    isDemo: true,
  },
  order: null,
  customer: amz2Customer,
  messages: [
    message({
      id: 'msg-amz2-1',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(26),
      text: 'Olá, boa noite! A camiseta premium veste justa ou solta? Tenho 1,78m e 78kg.',
    }),
    message({
      id: 'msg-amz2-2',
      direction: 'OUTBOUND_AGENT',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(25),
      text: 'Oi, Rafael! Para 1,78m e 78kg a G fica mais confortável. O modelo é levemente ajustado no tronco.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-3',
    }),
    message({
      id: 'msg-amz2-3',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: isoAgo(0.63),
      text: 'Perfeito. E vocês têm loja física? Queria experimentar antes de comprar.',
    }),
    message({
      id: 'msg-amz2-4',
      direction: 'INBOUND_BUYER',
      route: 'AMAZON_EMAIL_RELAY',
      at: AMZ2_LAST_MESSAGE,
      text: 'Consegue me mandar o link do guia de medidas?',
    }),
  ],
  events: [
    event('ev-amz2-1', 'TICKET_CREATED', 'Sistema', isoAgo(26), {
      marketplace: 'AMAZON',
      source: 'SES relay',
    }),
    event('ev-amz2-2', 'MESSAGE_SENT', 'Camila Duarte', isoAgo(25), {
      route: 'AMAZON_EMAIL_RELAY',
    }),
    event('ev-amz2-3', 'SLA_WARNING', 'Sistema', isoAgo(0.9), {
      slaDeadlineAt: AMZ2_DEADLINE,
      slaState: 'AT_RISK',
    }),
  ],
  routing: {
    route: 'AMAZON_EMAIL_RELAY',
    label: 'Buyer-Seller Relay (SMTP)',
    reason: 'Resposta receptiva: o comprador iniciou a conversa por e-mail.',
    blocked: false,
    warnings: [],
    recipient: 'BUYER',
    requiresAttachmentUpload: false,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'AMAZON_WARRANTY',
      label: 'Enviar Garantia / NF',
      description: 'Envia a nota fiscal e o termo de garantia.',
      route: 'AMAZON_SP_API_MESSAGING',
      enabled: false,
      destructive: false,
      requiresConfirmation: false,
      source: 'system',
    },
    {
      kind: 'AMAZON_NO_RESPONSE_NEEDED',
      label: 'Finalizar sem Resposta',
      description: 'Marca o ticket como sem resposta necessária.',
      route: 'AMAZON_EMAIL_RELAY',
      enabled: true,
      destructive: true,
      requiresConfirmation: true,
      source: 'system',
    },
  ],
  crr: null,
};

/* ==========================================================================
 * Ticket 3 — Mercado Livre claim ativo
 * ========================================================================== */

const MELI1_ORDER_ID = '2000012345678901';
const MELI1_CLAIM_ID = '5219984321';
const MELI1_DEADLINE = isoIn(2.73);
const MELI1_LAST_MESSAGE = isoAgo(0.37);

const meli1Order: OrderView = {
  externalOrderId: MELI1_ORDER_ID,
  packId: MELI1_ORDER_ID,
  orderStatus: 'DELIVERED',
  fulfillmentType: 'Mercado Envios',
  totalAmount: 389.9,
  currency: 'BRL',
  trackingNumber: 'MELI-98451237',
  carrierName: 'Mercado Envios',
  items: [
    item({
      mlb: 'MLB3721894054',
      sku: 'MNC-FONE-BT-ANC',
      asin: null,
      itemId: 'MLB3721894054',
      title: 'Fone Bluetooth Premium com Cancelamento de Ruído',
      quantity: 1,
      unitPrice: 389.9,
      imageUrl: null,
      variation: 'Preto',
    }),
  ],
  allowedActions: {},
  shipping: {
    carrier: 'Mercado Envios',
    tracking: 'MELI-98451237',
    service: 'Full',
    events: [
      { status: 'Pedido despachado', at: isoAgo(192), location: 'São Paulo, SP' },
      { status: 'Em trânsito', at: isoAgo(168), location: 'Guarulhos, SP' },
      { status: 'Entregue', at: isoAgo(144), location: 'São Paulo, SP' },
    ],
  },
  estimatedDeliveryAt: isoAgo(150),
  shippedAt: isoAgo(192),
  deliveredAt: isoAgo(144),
  lastSyncedAt: isoAgo(0.2),
};

const meli1Customer: CustomerView = {
  externalId: '112233445',
  displayName: 'Juliana Prado',
  anonymizedEmail: 'j***a@mercadolivre.com.br',
  document: '318.***.***-05',
  phone: '(11) 988**-**22',
  email: null,
  shippingAddress: {
    line1: 'Av. Paulista, 1578',
    line2: 'Apto 121',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01310-200',
    country: 'BR',
  },
  piiProtection: 'STANDARD',
  consents: { marketing: false },
};

const meli1Detail: TicketDetail = {
  ticket: {
    id: 'tkt-meli-001',
    marketplace: 'MERCADO_LIVRE',
    accountId: 'acc-meli-001',
    accountDisplayName: 'Mercado Livre · Minha Marca Oficial',
    ticketType: 'CLAIM_DISPUTE',
    subject: 'Reclamação: produto chegou com defeito',
    externalReferenceId: MELI1_CLAIM_ID,
    externalOrderId: MELI1_ORDER_ID,
    buyerDisplayName: 'Juliana Prado',
    buyerAnonymizedEmail: 'j***a@mercadolivre.com.br',
    hasActiveClaim: true,
    status: 'MEDIATION',
    priority: 'CRITICAL_SLA',
    slaDeadlineAt: MELI1_DEADLINE,
    slaState: 'AT_RISK',
    slaBreached: false,
    firstResponseAt: isoAgo(4.3),
    lastMessageAt: MELI1_LAST_MESSAGE,
    unreadCount: 1,
    assignedAgentId: 'a-1',
    assignedAgentName: 'Ana Ribeiro',
    assignedQueue: 'SAC::Meli-Claims',
    channelMetadata: {
      claim_id: MELI1_CLAIM_ID,
      due_date: MELI1_DEADLINE,
      available_actions: ['allow_return', 'refund', 'open_dispute'],
      action_guide: [
        { id: 'PDD9932', name: 'Produto com defeito', requires_text: true },
        { id: 'PDD9933', name: 'Produto diferente do anunciado', requires_text: true },
        { id: 'OTHER', name: 'Outro motivo', requires_text: true },
      ],
      pack_id: MELI1_ORDER_ID,
      conversation_status: 'blocked',
      mediator_present: true,
      question_id: null,
      item_id: null,
    },
    tags: ['CLAIM', 'MEDIAÇÃO'],
    isDemo: true,
  },
  order: meli1Order,
  customer: meli1Customer,
  messages: [
    message({
      id: 'msg-meli1-1',
      direction: 'INBOUND_BUYER',
      route: 'MELI_MESSAGES_API',
      at: isoAgo(5),
      text: 'Recebi o fone hoje e ele não liga de jeito nenhum. Já testei outra tomada e outro cabo. Quero resolver isso.',
    }),
    message({
      id: 'msg-meli1-2',
      direction: 'OUTBOUND_AGENT',
      route: 'MELI_MESSAGES_API',
      at: isoAgo(4.3),
      text: 'Oi, Juliana! Sinto muito pelo transtorno. Vou verificar o caso do seu pedido e já te retorno com a solução.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-1',
    }),
    message({
      id: 'msg-meli1-3',
      direction: 'INBOUND_BUYER',
      route: 'MELI_CLAIMS_API',
      at: isoAgo(3),
      text: 'Abri a reclamação no Mercado Livre porque não tive retorno. O produto está na caixa, sem uso além do teste.',
    }),
    message({
      id: 'msg-meli1-4',
      direction: 'MEDIATOR',
      route: 'MELI_CLAIMS_API',
      at: isoAgo(1.5),
      text: 'Reclamação aberta. O vendedor deve responder em até 24h com uma proposta de solução (devolução, reembolso ou mediação).',
    }),
    message({
      id: 'msg-meli1-5',
      direction: 'INBOUND_BUYER',
      route: 'MELI_CLAIMS_API',
      at: MELI1_LAST_MESSAGE,
      text: 'Anexei as fotos do produto com o defeito. Aguardo o retorno de vocês.',
      attachments: [attachment('att-meli1-1', 'fone-defeito.jpg', 'image/jpeg', 262_144)],
    }),
  ],
  events: [
    event('ev-meli1-1', 'TICKET_CREATED', 'Sistema', isoAgo(5), {
      marketplace: 'MERCADO_LIVRE',
      topic: 'messages',
    }),
    event('ev-meli1-2', 'MESSAGE_SENT', 'Ana Ribeiro', isoAgo(4.3), {
      route: 'MELI_MESSAGES_API',
    }),
    event('ev-meli1-3', 'CLAIM_OPENED', 'Mercado Livre', isoAgo(3), {
      claimId: MELI1_CLAIM_ID,
      dueDate: MELI1_DEADLINE,
    }),
    event('ev-meli1-4', 'SLA_UPDATED', 'Sistema', isoAgo(2.9), {
      slaDeadlineAt: MELI1_DEADLINE,
      slaState: 'AT_RISK',
    }),
  ],
  routing: {
    route: 'MELI_CLAIMS_API',
    label: 'Meli Claims API',
    reason: 'Reclamação ativa: o chat comum está bloqueado e a resposta segue pela API de Claims.',
    blocked: false,
    warnings: ['Chat normal bloqueado enquanto a reclamação estiver ativa'],
    recipient: 'BUYER',
    requiresAttachmentUpload: true,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'MELI_ALLOW_RETURN',
      label: 'Autorizar Devolução',
      description: 'Autoriza a devolução e gera a etiqueta de retorno para o comprador.',
      route: 'MELI_CLAIMS_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: true,
      source: 'claim.available_actions',
    },
    {
      kind: 'MELI_REFUND',
      label: 'Reembolsar Cliente',
      description: 'Reembolsa integralmente o valor pago pelo comprador.',
      route: 'MELI_CLAIMS_API',
      enabled: true,
      destructive: true,
      requiresConfirmation: true,
      source: 'claim.available_actions',
    },
    {
      kind: 'MELI_OPEN_DISPUTE',
      label: 'Pedir Mediação Meli',
      description: 'Escala a reclamação para a mediação do Mercado Livre.',
      route: 'MELI_CLAIMS_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: true,
      source: 'claim.available_actions',
    },
  ],
  crr: null,
};

/* ==========================================================================
 * Ticket 4 — Mercado Livre pré-venda (questions API)
 * ========================================================================== */

const MELI2_QUESTION_ID = '12984550023';
const MELI2_DEADLINE = isoIn(0.87);
const MELI2_LAST_MESSAGE = isoAgo(0.6);

const meli2Customer: CustomerView = {
  externalId: '556677889',
  displayName: 'Thiago Menezes',
  anonymizedEmail: 't***o@mercadolivre.com.br',
  document: null,
  phone: null,
  email: null,
  shippingAddress: null,
  piiProtection: 'STANDARD',
  consents: {},
};

const meli2Detail: TicketDetail = {
  ticket: {
    id: 'tkt-meli-002',
    marketplace: 'MERCADO_LIVRE',
    accountId: 'acc-meli-001',
    accountDisplayName: 'Mercado Livre · Minha Marca Oficial',
    ticketType: 'PRE_SALE',
    subject: 'Pergunta: o fone é compatível com iPhone 15?',
    externalReferenceId: MELI2_QUESTION_ID,
    externalOrderId: null,
    buyerDisplayName: 'Thiago Menezes',
    buyerAnonymizedEmail: 't***o@mercadolivre.com.br',
    hasActiveClaim: false,
    status: 'UNREAD',
    priority: 'HIGH',
    slaDeadlineAt: MELI2_DEADLINE,
    slaState: 'AT_RISK',
    slaBreached: false,
    firstResponseAt: isoAgo(25),
    lastMessageAt: MELI2_LAST_MESSAGE,
    unreadCount: 2,
    assignedAgentId: null,
    assignedAgentName: null,
    assignedQueue: 'COMERCIAL::Pre-Venda',
    channelMetadata: {
      claim_id: null,
      due_date: MELI2_DEADLINE,
      available_actions: [],
      action_guide: [],
      pack_id: null,
      conversation_status: 'open',
      mediator_present: false,
      question_id: MELI2_QUESTION_ID,
      item_id: 'MLB3721894054',
    },
    tags: ['PRÉ-VENDA', 'NÃO ATRIBUÍDO'],
    isDemo: true,
  },
  order: null,
  customer: meli2Customer,
  messages: [
    message({
      id: 'msg-meli2-1',
      direction: 'INBOUND_BUYER',
      route: 'MELI_QUESTIONS_API',
      at: isoAgo(26),
      text: 'Olá, boa noite! O fone tem cancelamento de ruído ativo mesmo?',
    }),
    message({
      id: 'msg-meli2-2',
      direction: 'OUTBOUND_AGENT',
      route: 'MELI_QUESTIONS_API',
      at: isoAgo(25),
      text: 'Oi, Thiago! Sim, o modelo tem ANC híbrido com até 32 dB de redução e modo transparência.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-2',
    }),
    message({
      id: 'msg-meli2-3',
      direction: 'INBOUND_BUYER',
      route: 'MELI_QUESTIONS_API',
      at: isoAgo(0.63),
      text: 'Perfeito. Ele funciona com iPhone 15 e tem garantia de quanto tempo?',
    }),
    message({
      id: 'msg-meli2-4',
      direction: 'INBOUND_BUYER',
      route: 'MELI_QUESTIONS_API',
      at: MELI2_LAST_MESSAGE,
      text: 'Também queria saber se acompanha case de carregamento.',
    }),
  ],
  events: [
    event('ev-meli2-1', 'TICKET_CREATED', 'Sistema', isoAgo(26), {
      marketplace: 'MERCADO_LIVRE',
      topic: 'questions',
    }),
    event('ev-meli2-2', 'MESSAGE_SENT', 'Bruno Carvalho', isoAgo(25), {
      route: 'MELI_QUESTIONS_API',
    }),
    event('ev-meli2-3', 'SLA_WARNING', 'Sistema', isoAgo(0.8), {
      slaDeadlineAt: MELI2_DEADLINE,
      slaState: 'AT_RISK',
    }),
  ],
  routing: {
    route: 'MELI_QUESTIONS_API',
    label: 'Meli Questions API',
    reason: 'Pergunta pré-venda: a resposta é publicada na página do anúncio.',
    blocked: false,
    warnings: [],
    recipient: 'BUYER',
    requiresAttachmentUpload: false,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'MELI_ANSWER_QUESTION',
      label: 'Responder Pergunta',
      description: 'Publica a resposta na página do anúncio.',
      route: 'MELI_QUESTIONS_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: false,
      source: 'questions',
    },
  ],
  crr: null,
};

/* ==========================================================================
 * Ticket 5 — Shopee pós-venda com CRR em risco
 * ========================================================================== */

const SHOP1_ORDER_SN = '241105XKQ9RT8P';
const SHOP1_DEADLINE = isoIn(9.67);
const SHOP1_LAST_MESSAGE = isoAgo(11.2);

const shop1Order: OrderView = {
  externalOrderId: SHOP1_ORDER_SN,
  packId: null,
  orderStatus: 'IN_TRANSIT',
  fulfillmentType: 'Shopee Xpress',
  totalAmount: 159.8,
  currency: 'BRL',
  trackingNumber: 'SPXBR24110500Q9RT',
  carrierName: 'Shopee Xpress',
  items: [
    item({
      itemId: '1849203847',
      sku: 'MNC-ORGANIZADOR-2',
      asin: null,
      mlb: null,
      title: 'Organizador de Malas 2 Peças — Cinza',
      quantity: 1,
      unitPrice: 159.8,
      imageUrl: null,
      variation: 'Cinza',
    }),
  ],
  allowedActions: {},
  shipping: {
    carrier: 'Shopee Xpress',
    tracking: 'SPXBR24110500Q9RT',
    service: 'Padrão',
    events: [
      { status: 'Objeto coletado', at: isoAgo(72), location: 'Cajamar, SP' },
      { status: 'Em trânsito', at: isoAgo(48), location: 'Cajamar, SP' },
      { status: 'Chegou ao centro de distribuição', at: isoAgo(24), location: 'São Paulo, SP' },
    ],
  },
  estimatedDeliveryAt: isoIn(48),
  shippedAt: isoAgo(72),
  deliveredAt: null,
  lastSyncedAt: isoAgo(0.3),
};

const shop1Customer: CustomerView = {
  externalId: '778899112',
  displayName: 'Larissa Gomes',
  anonymizedEmail: 'l***a@shopee.com.br',
  document: null,
  phone: '(21) 9****-*660',
  email: null,
  shippingAddress: {
    line1: 'Rua Barata Ribeiro, 1022',
    line2: 'Casa 3',
    district: 'Copacabana',
    city: 'Rio de Janeiro',
    state: 'RJ',
    postalCode: '22051-000',
    country: 'BR',
  },
  piiProtection: 'STANDARD',
  consents: { marketing: true },
};

const shop1Crr: CrrStatusView = {
  safe: false,
  targetHours: 12,
  hoursSinceLastInbound: 11.2,
  lastMessageDirection: 'INBOUND_BUYER',
  label: 'CRR em risco · 48 min restantes',
};

const shop1Detail: TicketDetail = {
  ticket: {
    id: 'tkt-shopee-001',
    marketplace: 'SHOPEE',
    accountId: 'acc-shopee-001',
    accountDisplayName: 'Shopee · Minha Marca BR',
    ticketType: 'POST_SALE_ORDER',
    subject: 'Pedido ainda não chegou — rastreio parado',
    externalReferenceId: 'conv-9932018477',
    externalOrderId: SHOP1_ORDER_SN,
    buyerDisplayName: 'Larissa Gomes',
    buyerAnonymizedEmail: 'l***a@shopee.com.br',
    hasActiveClaim: false,
    status: 'OPEN_WAITING_AGENT',
    priority: 'HIGH',
    slaDeadlineAt: SHOP1_DEADLINE,
    slaState: 'ON_TRACK',
    slaBreached: false,
    firstResponseAt: isoAgo(25),
    lastMessageAt: SHOP1_LAST_MESSAGE,
    unreadCount: 1,
    assignedAgentId: 'a-2',
    assignedAgentName: 'Bruno Carvalho',
    assignedQueue: 'SAC::Shopee-N1',
    channelMetadata: {
      conversation_id: 'conv-9932018477',
      order_sn: SHOP1_ORDER_SN,
      unread_count: 1,
      crr_safe: false,
      return_sn: null,
      tracking_number: 'SPXBR24110500Q9RT',
      crr_target_hours: 12,
      crr_hours_since_inbound: 11.2,
      dispute_level: null,
      preferred_agent_id: 'a-2',
    },
    tags: ['CRR', 'PÓS-VENDA'],
    isDemo: true,
  },
  order: shop1Order,
  customer: shop1Customer,
  messages: [
    message({
      id: 'msg-shop1-1',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(26),
      text: 'Oi! Comprei o organizador de malas e o rastreio está parado em Cajamar desde segunda. Vocês podem verificar?',
    }),
    message({
      id: 'msg-shop1-2',
      direction: 'OUTBOUND_AGENT',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(25),
      text: 'Oi, Larissa! Tudo bem? Temos a mesma atualização aqui. Já abrimos um caso com a Shopee Xpress e vamos te atualizar por aqui.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-2',
    }),
    message({
      id: 'msg-shop1-3',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(12),
      text: 'Já passaram dois dias e nada. Preciso do produto até dia 12 para uma viagem.',
    }),
    message({
      id: 'msg-shop1-4',
      direction: 'OUTBOUND_AGENT',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(11.83),
      text: 'Atualização: o pacote chegou ao centro de distribuição de São Paulo hoje de manhã. A previsão é de entrega em até 48h.',
      deliveryStatus: 'DELIVERED',
      authorAgentId: 'a-2',
    }),
    message({
      id: 'msg-shop1-5',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: SHOP1_LAST_MESSAGE,
      text: 'Ok. Se não chegar até dia 12, quero cancelar e receber o reembolso.',
    }),
  ],
  events: [
    event('ev-shop1-1', 'TICKET_CREATED', 'Sistema', isoAgo(26), {
      marketplace: 'SHOPEE',
      conversationId: 'conv-9932018477',
    }),
    event('ev-shop1-2', 'MESSAGE_SENT', 'Bruno Carvalho', isoAgo(25), {
      route: 'SHOPEE_CHAT_API',
    }),
    event('ev-shop1-3', 'CRR_WARNING', 'Sistema', isoAgo(0.9), {
      crrSafe: false,
      hoursSinceLastInbound: 11.2,
    }),
  ],
  routing: {
    route: 'SHOPEE_CHAT_API',
    label: 'Shopee Chat API',
    reason: 'Chat pós-venda da Shopee: resposta direta com proteção de CRR.',
    blocked: false,
    warnings: ['Responda em até 48 min para proteger o CRR (janela de 12h)'],
    recipient: 'BUYER',
    requiresAttachmentUpload: false,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'SHOPEE_MARK_READ',
      label: 'Encerrar + Marcar Lido (Proteger CRR)',
      description: 'Marca a conversa como lida e garante que a última mensagem seja outbound.',
      route: 'SHOPEE_CHAT_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: false,
      source: 'shopee',
    },
    {
      kind: 'SHOPEE_ACCEPT_CANCELLATION',
      label: 'Aceitar Cancelamento',
      description: 'Aceita o cancelamento solicitado pelo comprador (quando existir).',
      route: 'SHOPEE_CHAT_API',
      enabled: false,
      destructive: true,
      requiresConfirmation: true,
      source: 'shopee',
    },
    {
      kind: 'SHOPEE_DISPUTE_RETURN',
      label: 'Abrir Disputa de Devolução',
      description: 'Abre disputa N2 de devolução — requer return_sn.',
      route: 'SHOPEE_RETURNS_API',
      enabled: false,
      destructive: true,
      requiresConfirmation: true,
      source: 'shopee',
    },
  ],
  crr: shop1Crr,
};

/* ==========================================================================
 * Ticket 6 — Shopee disputa de devolução N2 (SLA violado)
 * ========================================================================== */

const SHOP2_ORDER_SN = '240918ABCD1234';
const SHOP2_RETURN_SN = '2409R7K2P9';
const SHOP2_DEADLINE = isoIn(-0.7);
const SHOP2_LAST_MESSAGE = isoAgo(1.08);

const shop2Order: OrderView = {
  externalOrderId: SHOP2_ORDER_SN,
  packId: null,
  orderStatus: 'IN_RETURN',
  fulfillmentType: 'Shopee Xpress',
  totalAmount: 129.9,
  currency: 'BRL',
  trackingNumber: 'SPXBR24091877K2P',
  carrierName: 'Shopee Xpress',
  items: [
    item({
      itemId: '1849203999',
      sku: 'MNC-TENIS-38',
      asin: null,
      mlb: null,
      title: 'Tênis Casual Masculino — Cinza, 38',
      quantity: 1,
      unitPrice: 129.9,
      imageUrl: null,
      variation: 'Cinza / 38',
    }),
  ],
  allowedActions: {},
  shipping: {
    carrier: 'Shopee Xpress',
    tracking: 'SPXBR24091877K2P',
    service: 'Devolução',
    events: [
      { status: 'Entregue ao comprador', at: daysAgo(12), location: 'Belo Horizonte, MG' },
      { status: 'Devolução solicitada', at: daysAgo(9), location: 'Belo Horizonte, MG' },
      { status: 'Objeto em trânsito (devolução)', at: daysAgo(2), location: 'Contagem, MG' },
    ],
  },
  estimatedDeliveryAt: daysAgo(12),
  shippedAt: daysAgo(15),
  deliveredAt: daysAgo(12),
  lastSyncedAt: isoAgo(0.5),
};

const shop2Customer: CustomerView = {
  externalId: '990011223',
  displayName: 'Pedro Henrique Souza',
  anonymizedEmail: 'p***o@shopee.com.br',
  document: null,
  phone: '(31) 9****-*118',
  email: null,
  shippingAddress: {
    line1: 'Rua dos Aimorés, 2450',
    line2: 'Sala 12',
    district: 'Funcionários',
    city: 'Belo Horizonte',
    state: 'MG',
    postalCode: '30140-071',
    country: 'BR',
  },
  piiProtection: 'STANDARD',
  consents: {},
};

const shop2Crr: CrrStatusView = {
  safe: true,
  targetHours: 12,
  hoursSinceLastInbound: 1.1,
  lastMessageDirection: 'INBOUND_BUYER',
  label: 'CRR OK · 10h54 restantes',
};

const shop2Detail: TicketDetail = {
  ticket: {
    id: 'tkt-shopee-002',
    marketplace: 'SHOPEE',
    accountId: 'acc-shopee-001',
    accountDisplayName: 'Shopee · Minha Marca BR',
    ticketType: 'RETURN_REFUND',
    subject: `Disputa de devolução N2 — return_sn ${SHOP2_RETURN_SN}`,
    externalReferenceId: SHOP2_RETURN_SN,
    externalOrderId: SHOP2_ORDER_SN,
    buyerDisplayName: 'Pedro Henrique Souza',
    buyerAnonymizedEmail: 'p***o@shopee.com.br',
    hasActiveClaim: true,
    status: 'OPEN_WAITING_AGENT',
    priority: 'CRITICAL_SLA',
    slaDeadlineAt: SHOP2_DEADLINE,
    slaState: 'BREACHED',
    slaBreached: true,
    firstResponseAt: isoAgo(167),
    lastMessageAt: SHOP2_LAST_MESSAGE,
    unreadCount: 2,
    assignedAgentId: 'a-1',
    assignedAgentName: 'Ana Ribeiro',
    assignedQueue: 'SAC::Shopee-N2-Retencao',
    channelMetadata: {
      conversation_id: 'conv-9932019922',
      order_sn: SHOP2_ORDER_SN,
      unread_count: 2,
      crr_safe: true,
      return_sn: SHOP2_RETURN_SN,
      tracking_number: 'SPXBR24091877K2P',
      crr_target_hours: 12,
      crr_hours_since_inbound: 1.1,
      dispute_level: 'N2',
      preferred_agent_id: 'a-1',
    },
    tags: ['DISPUTA N2', 'CRR', 'N2'],
    isDemo: true,
  },
  order: shop2Order,
  customer: shop2Customer,
  messages: [
    message({
      id: 'msg-shop2-1',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: daysAgo(7),
      text: 'Recebi o tênis e ficou grande. Quero devolver e receber o reembolso.',
    }),
    message({
      id: 'msg-shop2-2',
      direction: 'OUTBOUND_AGENT',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(167),
      text: 'Sem problemas, Pedro! Abri a solicitação de devolução e você receberá a etiqueta por e-mail em até 48h.',
      deliveryStatus: 'READ',
      authorAgentId: 'a-1',
    }),
    message({
      id: 'msg-shop2-3',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: daysAgo(3),
      text: 'Já postei o produto e o rastreio mostra entregue no centro de devoluções, mas ainda não recebi o reembolso.',
    }),
    message({
      id: 'msg-shop2-4',
      direction: 'OUTBOUND_AGENT',
      route: 'SHOPEE_RETURNS_API',
      at: daysAgo(2),
      text: 'Obrigada pelo retorno. A devolução foi recebida e está em conferência; o estorno é processado em até 3 dias úteis após a aprovação.',
      deliveryStatus: 'DELIVERED',
      authorAgentId: 'a-1',
    }),
    message({
      id: 'msg-shop2-5',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: isoAgo(1.5),
      text: 'Já se passaram mais de 24h e nada. Isso é um desrespeito — vou abrir disputa no Shopee e no Reclame Aqui.',
    }),
    message({
      id: 'msg-shop2-6',
      direction: 'INBOUND_BUYER',
      route: 'SHOPEE_CHAT_API',
      at: SHOP2_LAST_MESSAGE,
      text: 'Anexei o comprovante de postagem e a captura do pedido de devolução.',
      attachments: [attachment('att-shop2-1', 'comprovante-postagem.pdf', 'application/pdf', 412_672)],
    }),
  ],
  events: [
    event('ev-shop2-1', 'TICKET_CREATED', 'Sistema', daysAgo(7), {
      marketplace: 'SHOPEE',
      conversationId: 'conv-9932019922',
    }),
    event('ev-shop2-2', 'RETURN_REQUESTED', 'Shopee', daysAgo(9), {
      returnSn: SHOP2_RETURN_SN,
    }),
    event('ev-shop2-3', 'DISPUTE_OPENED', 'Shopee', daysAgo(2), {
      level: 'N2',
      returnSn: SHOP2_RETURN_SN,
    }),
    event('ev-shop2-4', 'SLA_BREACHED', 'Sistema', isoAgo(0.7), {
      slaDeadlineAt: SHOP2_DEADLINE,
      slaState: 'BREACHED',
      slaBreached: true,
    }),
  ],
  routing: {
    route: 'SHOPEE_RETURNS_API',
    label: 'Shopee Returns API',
    reason: 'Disputa de devolução N2: as ações devem ser tomadas pela API de Devoluções.',
    blocked: false,
    warnings: ['SLA fatal violado há 42 minutos — priorize esta conversa'],
    recipient: 'BUYER',
    requiresAttachmentUpload: false,
    forcedImportant: false,
  },
  allowedActions: [
    {
      kind: 'SHOPEE_CONFIRM_RETURN',
      label: 'Confirmar Recebimento da Devolução',
      description: 'Confirma o recebimento da devolução e libera o reembolso.',
      route: 'SHOPEE_RETURNS_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: true,
      source: 'returns',
    },
    {
      kind: 'SHOPEE_DISPUTE_RETURN',
      label: 'Abrir Disputa de Devolução',
      description: 'Contesta a devolução com evidências anexadas.',
      route: 'SHOPEE_RETURNS_API',
      enabled: true,
      destructive: true,
      requiresConfirmation: true,
      source: 'returns',
    },
    {
      kind: 'SHOPEE_MARK_READ',
      label: 'Encerrar + Marcar Lido (Proteger CRR)',
      description: 'Marca a conversa como lida e protege o índice de CRR.',
      route: 'SHOPEE_CHAT_API',
      enabled: true,
      destructive: false,
      requiresConfirmation: false,
      source: 'shopee',
    },
  ],
  crr: shop2Crr,
};

/* ==========================================================================
 * Exports consumed by the API mock + UI
 * ========================================================================== */

export const mockDetails: Record<string, TicketDetail> = {
  [amz1Detail.ticket.id]: amz1Detail,
  [amz2Detail.ticket.id]: amz2Detail,
  [meli1Detail.ticket.id]: meli1Detail,
  [meli2Detail.ticket.id]: meli2Detail,
  [shop1Detail.ticket.id]: shop1Detail,
  [shop2Detail.ticket.id]: shop2Detail,
};

/** Queue order: soonest SLA deadline first (same rule as the API). */
export const mockTickets: TicketListItem[] = Object.values(mockDetails)
  .map((detail) => detail.ticket)
  .sort(
    (left, right) =>
      new Date(left.slaDeadlineAt).getTime() - new Date(right.slaDeadlineAt).getTime(),
  );

/** Stats derived from the live ticket list so counts never drift. */
export function buildTicketStats(items: TicketListItem[]): TicketStats {
  const byMarketplace: Record<Marketplace, number> = {
    AMAZON: 0,
    MERCADO_LIVRE: 0,
    SHOPEE: 0,
  };
  let unread = 0;
  let openWaitingAgent = 0;
  let atRisk = 0;
  let breached = 0;
  let firstResponseSum = 0;
  let firstResponseCount = 0;

  for (const ticket of items) {
    byMarketplace[ticket.marketplace] += 1;
    unread += ticket.unreadCount;
    if (ticket.status === 'OPEN_WAITING_AGENT' || ticket.status === 'UNREAD') {
      openWaitingAgent += 1;
    }
    if (ticket.slaState === 'AT_RISK') atRisk += 1;
    if (ticket.slaState === 'BREACHED' || ticket.slaBreached) breached += 1;
    if (ticket.firstResponseAt) {
      const minutes = (Date.now() - new Date(ticket.firstResponseAt).getTime()) / 60_000;
      if (Number.isFinite(minutes) && minutes > 0) {
        firstResponseSum += minutes;
        firstResponseCount += 1;
      }
    }
  }

  const avgFirstResponse =
    firstResponseCount > 0 ? Math.round(firstResponseSum / firstResponseCount) : null;

  return {
    total: items.length,
    unread,
    openWaitingAgent,
    atRisk,
    breached,
    // Demo keeps the "lifetime" average stable around 4h12 regardless of the
    // current (young) queue sample.
    avgFirstResponseMinutes: avgFirstResponse ?? 252,
    avgResolutionMinutes: 1389,
    byMarketplace,
  };
}

export const mockStats: TicketStats = buildTicketStats(mockTickets);

/** Total open tickets shown in the topbar "N na fila" chip. */
export const mockQueueTotal = mockTickets.length;
