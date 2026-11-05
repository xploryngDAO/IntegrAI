/* eslint-disable no-console */
/**
 * SAC Hub demo seed.
 *
 * Creates a realistic operating picture across the three channels so the
 * workspace can be demoed against a live API (the web app also ships an
 * offline mock mode that mirrors this dataset).
 *
 * Run: npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const at = (offsetMs: number): Date => new Date(now + offsetMs);
const ago = (offsetMs: number): Date => new Date(now - offsetMs);

const DEMO_SELLERS = {
  amazon: 'A2Q3Y263D00KWC',
  meli: '123456789',
  shopee: '987654321',
};

async function resetDemoAccounts(): Promise<void> {
  await prisma.marketplaceAccount.deleteMany({
    where: {
      externalSellerId: { in: [DEMO_SELLERS.amazon, DEMO_SELLERS.meli, DEMO_SELLERS.shopee] },
    },
  });
}

async function seedAgents(): Promise<Record<string, string>> {
  const passwordHash = await bcrypt.hash('sac-hub-2024', 10);
  const agents = [
    { email: 'marina@sachub.demo', name: 'Marina Lopes', role: 'ADMIN', presence: 'ONLINE', avatarColor: '#3B82F6' },
    { email: 'ana@sachub.demo', name: 'Ana Souza', role: 'AGENT', presence: 'ONLINE', avatarColor: '#34D399' },
    { email: 'bruno@sachub.demo', name: 'Bruno Lima', role: 'AGENT', presence: 'PAUSED', avatarColor: '#FAAD14' },
    { email: 'carla@sachub.demo', name: 'Carla Dias', role: 'SUPERVISOR', presence: 'OFFLINE', avatarColor: '#EE4D2D' },
  ] as const;

  const ids: Record<string, string> = {};
  for (const agent of agents) {
    const record = await prisma.agent.upsert({
      where: { email: agent.email },
      update: { name: agent.name, role: agent.role, presence: agent.presence, avatarColor: agent.avatarColor },
      create: {
        email: agent.email,
        name: agent.name,
        passwordHash,
        role: agent.role,
        presence: agent.presence,
        avatarColor: agent.avatarColor,
        maxConcurrent: 20,
        lastSeenAt: agent.presence === 'OFFLINE' ? ago(3 * HOUR) : new Date(),
      },
    });
    ids[agent.email.split('@')[0]!] = record.id;
  }
  return ids;
}

async function seedAccounts(): Promise<Record<string, string>> {
  const amazon = await prisma.marketplaceAccount.create({
    data: {
      marketplace: 'AMAZON',
      displayName: 'Amazon BR · Minha Marca',
      externalSellerId: DEMO_SELLERS.amazon,
      marketplaceSiteId: 'A2Q3Y263D00KWC',
      status: 'ACTIVE',
      tokenExpiresAt: at(48 * MIN),
      authExpiresAt: at(320 * DAY),
      channelConfig: {
        smtp_sender_email: 'atendimento@minhamarca.com.br',
        inbound_email_route: 'amazon-relay@sachub.demo',
        approved_sender_domains: ['minhamarca.com.br'],
        seller_central_region: 'BR',
      },
    },
  });

  const meli = await prisma.marketplaceAccount.create({
    data: {
      marketplace: 'MERCADO_LIVRE',
      displayName: 'Mercado Livre · Minha Marca Oficial',
      externalSellerId: DEMO_SELLERS.meli,
      marketplaceSiteId: 'MLB',
      status: 'ACTIVE',
      tokenExpiresAt: at(5 * HOUR),
      authExpiresAt: at(170 * DAY),
      channelConfig: {
        site_id: 'MLB',
        mediator_enabled: true,
        reputation: { level: 'verde_5', claims_rate: 0.9 },
      },
    },
  });

  const shopee = await prisma.marketplaceAccount.create({
    data: {
      marketplace: 'SHOPEE',
      displayName: 'Shopee · Minha Marca BR',
      externalSellerId: DEMO_SELLERS.shopee,
      marketplaceSiteId: 'BR',
      status: 'ACTIVE',
      tokenExpiresAt: at(3 * HOUR),
      authExpiresAt: at(28 * DAY),
      channelConfig: {
        shop_id: 987654321,
        region: 'BR',
        crr_target: 95,
        logistics_partners: ['Shopee Xpress', 'J&T Express'],
      },
    },
  });

  return { amazon: amazon.id, meli: meli.id, shopee: shopee.id };
}

interface SeedOrder {
  key: string;
  accountId: string;
  marketplace: 'AMAZON' | 'MERCADO_LIVRE' | 'SHOPEE';
  externalOrderId: string;
  packId?: string;
  buyerExternalId: string;
  buyerName: string;
  buyerEmail?: string;
  status: string;
  fulfillment: string;
  total: number;
  tracking?: string;
  carrier?: string;
  items: Array<{ sku: string; asin?: string; mlb?: string; title: string; qty: number; price: number }>;
  allowedActions: Record<string, unknown>;
  shipping?: Record<string, unknown>;
}

async function seedOrders(accounts: Record<string, string>): Promise<Record<string, string>> {
  const orders: SeedOrder[] = [
    {
      key: 'amzOrder1',
      accountId: accounts.amazon!,
      marketplace: 'AMAZON',
      externalOrderId: '123-4567890-1234567',
      buyerExternalId: 'A1B2C3D4E5F6G7',
      buyerName: 'Camila Ferreira',
      buyerEmail: 'a1b2c3d4e5f6g7@marketplace.amazon.com.br',
      status: 'Shipped',
      fulfillment: 'FBA',
      total: 249.9,
      tracking: 'SSW123456789BR',
      carrier: 'Amazon Logistics',
      items: [
        { sku: 'MM-FONE-PRO-01', asin: 'B0C7X2L9KM', title: 'Fone Bluetooth Pro ANC — Preto', qty: 1, price: 249.9 },
      ],
      allowedActions: {
        source: 'getMessagingActionsForOrder',
        actions: ['confirmDeliveryDetails', 'unexpectedProblem', 'warranty', 'confirmCustomizationDetails'],
      },
      shipping: {
        carrier: 'Amazon Logistics',
        service: 'FBA Standard',
        tracking_number: 'SSW123456789BR',
        events: [
          { at: ago(2 * DAY).toISOString(), label: 'Pacote despachado do centro de distribuição', location: 'Cajamar, SP' },
          { at: ago(26 * HOUR).toISOString(), label: 'Em trânsito para a transportadora', location: 'São Paulo, SP' },
          { at: ago(4 * HOUR).toISOString(), label: 'Saiu para entrega', location: 'São Paulo, SP' },
        ],
      },
    },
    {
      key: 'meliOrder1',
      accountId: accounts.meli!,
      marketplace: 'MERCADO_LIVRE',
      externalOrderId: 'MLB3847291057',
      packId: '2000012345678901',
      buyerExternalId: '778899001',
      buyerName: 'rafael.martins',
      buyerEmail: 'rafael.martins@example.com',
      status: 'paid',
      fulfillment: 'Mercado Envios',
      total: 189.9,
      tracking: 'ME-8877665544',
      carrier: 'Mercado Envios',
      items: [
        { sku: 'MM-PEL-VIDRO-01', mlb: 'MLB3548127741', title: 'Película de Vidro 3D para iPhone 15', qty: 2, price: 79.95 },
        { sku: 'MM-CAPA-SIL-01', mlb: 'MLB3521478890', title: 'Capa Silicone Premium — Azul', qty: 1, price: 30.0 },
      ],
      allowedActions: { available_actions: ['allow_return', 'refund', 'open_dispute'] },
      shipping: {
        carrier: 'Mercado Envios',
        tracking_number: 'ME-8877665544',
        events: [
          { at: ago(3 * DAY).toISOString(), label: 'Envido', location: 'São Paulo, SP' },
          { at: ago(20 * HOUR).toISOString(), label: 'Entregue ao destinatário', location: 'Campinas, SP' },
        ],
      },
    },
    {
      key: 'meliOrder2',
      accountId: accounts.meli!,
      marketplace: 'MERCADO_LIVRE',
      externalOrderId: 'MLB3847291088',
      packId: '2000012345678999',
      buyerExternalId: '445566778',
      buyerName: 'juliana.souza',
      status: 'paid',
      fulfillment: 'Mercado Envios Full',
      total: 89.9,
      tracking: 'ME-1122334455',
      carrier: 'Mercado Envios',
      items: [{ sku: 'MM-CARREG-20W', mlb: 'MLB3512299001', title: 'Carregador Turbo 20W USB-C', qty: 1, price: 89.9 }],
      allowedActions: {},
    },
    {
      key: 'shopeeOrder1',
      accountId: accounts.shopee!,
      marketplace: 'SHOPEE',
      externalOrderId: '241105ABCDEFGH',
      buyerExternalId: 'bn_99112233',
      buyerName: 'thiago_almeida',
      status: 'SHIPPED',
      fulfillment: 'Shopee Xpress',
      total: 129.9,
      tracking: 'SPX-9911223344',
      carrier: 'Shopee Xpress',
      items: [
        { sku: 'MM-SUPORTE-NB-01', title: 'Suporte Ergonômico para Notebook — Alumínio', qty: 1, price: 129.9 },
      ],
      allowedActions: { actions: ['confirm_receive', 'cancel_order'] },
      shipping: {
        carrier: 'Shopee Xpress',
        tracking_number: 'SPX-9911223344',
        events: [
          { at: ago(30 * HOUR).toISOString(), label: 'Pacote coletado pelo motorista', location: 'Guarulhos, SP' },
          { at: ago(6 * HOUR).toISOString(), label: 'Em trânsito para o centro de distribuição local', location: 'São Paulo, SP' },
        ],
      },
    },
    {
      key: 'shopeeOrder2',
      accountId: accounts.shopee!,
      marketplace: 'SHOPEE',
      externalOrderId: '241101ZZYXWVUT',
      buyerExternalId: 'bn_44556677',
      buyerName: 'patricia_lima',
      status: 'TO_CONFIRM_RECEIVE',
      fulfillment: 'J&T Express',
      total: 59.9,
      tracking: 'JT-5566778899',
      carrier: 'J&T Express',
      items: [{ sku: 'MM-CABO-USB-2M', title: 'Cabo USB-C 2m Trançado 60W', qty: 1, price: 59.9 }],
      allowedActions: { actions: ['confirm_receive', 'cancel_order', 'return_refund'] },
      shipping: {
        carrier: 'J&T Express',
        tracking_number: 'JT-5566778899',
        events: [
          { at: ago(5 * DAY).toISOString(), label: 'Pedido entregue', location: 'Belo Horizonte, MG' },
        ],
      },
    },
  ];

  const ids: Record<string, string> = {};
  for (const order of orders) {
    const record = await prisma.orderCache.create({
      data: {
        accountId: order.accountId,
        marketplace: order.marketplace,
        externalOrderId: order.externalOrderId,
        packId: order.packId ?? null,
        buyerExternalId: order.buyerExternalId,
        buyerNameOrNick: order.buyerName,
        buyerAnonymizedEmail: order.buyerEmail ?? null,
        orderStatus: order.status,
        fulfillmentType: order.fulfillment,
        totalAmount: order.total,
        currency: 'BRL',
        trackingNumber: order.tracking ?? null,
        carrierName: order.carrier ?? null,
        itemsSnapshot: order.items,
        allowedActionsCache: order.allowedActions,
        shippingSnapshot: order.shipping ?? {},
        estimatedDeliveryAt: at(2 * DAY),
        shippedAt: ago(26 * HOUR),
        lastSyncedAt: ago(20 * MIN),
      },
    });
    ids[order.key] = record.id;
  }
  return ids;
}

interface SeedMessage {
  direction: 'INBOUND_BUYER' | 'OUTBOUND_AGENT' | 'OUTBOUND_SYSTEM' | 'EXTERNAL_SELLER_PANEL' | 'MEDIATOR';
  route:
    | 'AMAZON_EMAIL_RELAY'
    | 'AMAZON_SP_API_MESSAGING'
    | 'MELI_QUESTIONS_API'
    | 'MELI_MESSAGES_API'
    | 'MELI_CLAIMS_API'
    | 'SHOPEE_CHAT_API'
    | 'SHOPEE_RETURNS_API';
  text: string;
  minutesAgo: number;
  delivery?: 'SENT' | 'DELIVERED' | 'READ' | 'BOUNCED_BLOCKED' | 'QUEUED' | 'FAILED' | 'MODERATION_REJECTED';
  externalId?: string;
  messageType?: string;
  agentEmail?: string;
  contentPayload?: Record<string, unknown>;
  attachments?: Array<{ fileName: string; mimeType: string; sizeBytes: number }>;
}

async function seedTickets(
  accounts: Record<string, string>,
  orders: Record<string, string>,
  agents: Record<string, string>,
): Promise<void> {
  interface SeedTicket {
    key: string;
    accountId: string;
    marketplace: 'AMAZON' | 'MERCADO_LIVRE' | 'SHOPEE';
    ticketType: 'PRE_SALE' | 'POST_SALE_ORDER' | 'CLAIM_DISPUTE' | 'RETURN_REFUND' | 'CANCELLATION' | 'PROACTIVE';
    reference: string;
    orderId?: string;
    orderKey?: string;
    packId?: string;
    claimId?: string;
    conversationId?: string;
    returnSn?: string;
    subject: string;
    buyerName: string;
    buyerEmail?: string;
    buyerExternalId?: string;
    hasActiveClaim?: boolean;
    status: 'UNREAD' | 'OPEN_WAITING_AGENT' | 'WAITING_BUYER' | 'NO_RESPONSE_NEEDED' | 'MEDIATION' | 'RESOLVED';
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL_SLA';
    dueInMs: number;
    targetInMs?: number;
    queue: string;
    agentKey?: string | null;
    unread?: number;
    metadata: Record<string, unknown>;
    firstResponseMinutesAgo?: number;
    messages: SeedMessage[];
  }

  const tickets: SeedTicket[] = [
    {
      key: 'amz1',
      accountId: accounts.amazon!,
      marketplace: 'AMAZON',
      ticketType: 'POST_SALE_ORDER',
      reference: '123-4567890-1234567',
      orderId: '123-4567890-1234567',
      orderKey: 'amzOrder1',
      subject: 'Onde está meu pedido?',
      buyerName: 'Camila Ferreira',
      buyerEmail: 'a1b2c3d4e5f6g7@marketplace.amazon.com.br',
      buyerExternalId: 'A1B2C3D4E5F6G7',
      status: 'OPEN_WAITING_AGENT',
      priority: 'HIGH',
      dueInMs: 2 * HOUR + 15 * MIN,
      targetInMs: -45 * MIN,
      queue: 'SAC::Amazon',
      agentKey: 'ana',
      unread: 1,
      firstResponseMinutesAgo: 50,
      metadata: {
        no_response_link: 'https://sellercentral.amazon.com/messaging/no-response-needed?orderId=123-4567890-1234567',
        buyer_opt_out: false,
        allowed_spapi_actions: ['confirmDeliveryDetails', 'unexpectedProblem', 'warranty'],
        rdt_protected: true,
        email_thread_subject: 'Onde está meu pedido?',
      },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'AMAZON_EMAIL_RELAY',
          text:
            'Olá, bom dia. Fiz o pedido na quinta-feira e até agora o rastreio só mostra "saiu para entrega". Preciso do produto até amanhã para um presente. Vocês conseguem me confirmar o prazo?',
          minutesAgo: 180,
          externalId: '<CAF2E1A1-9D2F-4A5B-B3F4-1A2B3C4D5E6F@marketplace.amazon.com.br>',
          messageType: 'text',
        },
        {
          direction: 'OUTBOUND_AGENT',
          route: 'AMAZON_EMAIL_RELAY',
          text:
            'Olá, Camila! Tudo bem? Seu pedido consta como "saiu para entrega" na transportadora Amazon Logistics desde hoje pela manhã. O prazo estimado é até amanhã, 18h. Vou acompanhar por aqui e te aviso qualquer atualização.',
          minutesAgo: 50,
          delivery: 'DELIVERED',
          agentEmail: 'ana@sachub.demo',
          contentPayload: { smtp_message_id: '<reply-1@sachub.demo>', from: 'atendimento@minhamarca.com.br' },
        },
        {
          direction: 'INBOUND_BUYER',
          route: 'AMAZON_EMAIL_RELAY',
          text: 'Perfeito, obrigada! Fico no aguardo então.',
          minutesAgo: 12,
          externalId: '<CAF2E1A1-9D2F-4A5B-B3F4-2B3C4D5E6F70@marketplace.amazon.com.br>',
          messageType: 'text',
        },
      ],
    },
    {
      key: 'amz2',
      accountId: accounts.amazon!,
      marketplace: 'AMAZON',
      ticketType: 'PRE_SALE',
      reference: 'a9f8e7d6c5b4a3@marketplace.amazon.com.br',
      subject: 'Compatibilidade do carregador',
      buyerName: 'Comprante Amazon',
      buyerEmail: 'a9f8e7d6c5b4a3@marketplace.amazon.com.br',
      status: 'UNREAD',
      priority: 'MEDIUM',
      dueInMs: 18 * HOUR,
      targetInMs: 6 * HOUR,
      queue: 'SAC::Amazon',
      agentKey: null,
      unread: 2,
      metadata: { buyer_opt_out: true, allowed_spapi_actions: [], pre_sale: true },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'AMAZON_EMAIL_RELAY',
          text:
            'Boa tarde, o carregador de vocês é compatível com um Galaxy S23? E qual a garantia? Não quero receber mensagens promocionais, apenas sobre este pedido.',
          minutesAgo: 40,
          externalId: '<BEEF0001-1111-2222-3333-444455556666@marketplace.amazon.com.br>',
        },
      ],
    },
    {
      key: 'meli1',
      accountId: accounts.meli!,
      marketplace: 'MERCADO_LIVRE',
      ticketType: 'CLAIM_DISPUTE',
      reference: '5123456789',
      orderId: 'MLB3847291057',
      orderKey: 'meliOrder1',
      packId: '2000012345678901',
      claimId: '5123456789',
      subject: 'Comprador abriu reclamação: produto com defeito',
      buyerName: 'rafael.martins',
      buyerExternalId: '778899001',
      hasActiveClaim: true,
      status: 'MEDIATION',
      priority: 'CRITICAL_SLA',
      dueInMs: 3 * HOUR,
      targetInMs: 1 * HOUR,
      queue: 'SAC::Meli',
      agentKey: 'marina',
      unread: 3,
      firstResponseMinutesAgo: 90,
      metadata: {
        claim_id: '5123456789',
        claim_status: 'opened',
        claim_stage: 'claim',
        claim_type: 'return',
        due_date: at(3 * HOUR).toISOString(),
        mediator_present: false,
        available_actions: ['allow_return', 'refund', 'open_dispute'],
        players: [
          { role: 'complainant', user_id: '778899001' },
          { role: 'respondent', user_id: DEMO_SELLERS.meli },
        ],
        conversation_status: { status: 'blocked', reason: 'claim_open' },
        action_guide: {
          blocked: true,
          options: [
            { option_id: 'reason_1', description: 'Produto chegou com defeito' },
            { option_id: 'reason_2', description: 'Produto diferente do anunciado' },
            { option_id: 'reason_3', description: 'Não recebi o produto' },
          ],
        },
      },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'MELI_CLAIMS_API',
          text:
            'Recebi a película trincada e a capa veio na cor errada. Quero devolver os dois itens e receber o reembolso.',
          minutesAgo: 210,
          externalId: 'claim-msg-1',
          contentPayload: { claim_id: '5123456789' },
          attachments: [{ fileName: 'defeito.jpeg', mimeType: 'image/jpeg', sizeBytes: 245320 }],
        },
        {
          direction: 'OUTBOUND_AGENT',
          route: 'MELI_CLAIMS_API',
          text:
            'Olá Rafael! Sentimos muito pelo ocorrido. Vamos autorizar a devolução dos dois itens por defeito/troca. Você receberá a etiqueta de postagem em até 24h. Assim que o produto chegar ao centro de devoluções, o reembolso é liberado automaticamente.',
          minutesAgo: 90,
          delivery: 'DELIVERED',
          agentEmail: 'marina@sachub.demo',
          contentPayload: { receiver_role: 'complainant' },
        },
        {
          direction: 'MEDIATOR',
          route: 'MELI_CLAIMS_API',
          text:
            'O Mercado Livre interveio na reclamação. Informe se concorda com a devolução em até 24 horas para não haver reembolso automático ao comprador.',
          minutesAgo: 25,
          delivery: 'DELIVERED',
          contentPayload: { receiver_role: 'mediator' },
        },
      ],
    },
    {
      key: 'meli2',
      accountId: accounts.meli!,
      marketplace: 'MERCADO_LIVRE',
      ticketType: 'PRE_SALE',
      reference: '1876543210',
      subject: 'Pergunta sobre o produto: Cabo USB-C 2m',
      buyerName: 'juliana.souza',
      buyerExternalId: '445566778',
      status: 'OPEN_WAITING_AGENT',
      priority: 'MEDIUM',
      dueInMs: 1 * HOUR + 40 * MIN,
      targetInMs: 30 * MIN,
      queue: 'SAC::Meli',
      agentKey: null,
      unread: 1,
      metadata: {
        question_id: '1876543210',
        item_id: 'MLB3512299001',
        item_snapshot: {
          id: 'MLB3512299001',
          title: 'Carregador Turbo 20W USB-C',
          price: 89.9,
          permalink: 'https://produto.mercadolivre.com.br/MLB-3512299001',
        },
      },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'MELI_QUESTIONS_API',
          text: 'Esse carregador funciona com iPhone 14? Ele já vem com o cabo?',
          minutesAgo: 20,
          externalId: 'q:1876543210',
        },
      ],
    },
    {
      key: 'shopee1',
      accountId: accounts.shopee!,
      marketplace: 'SHOPEE',
      ticketType: 'POST_SALE_ORDER',
      reference: 'conv_77229911',
      orderId: '241105ABCDEFGH',
      orderKey: 'shopeeOrder1',
      conversationId: 'conv_77229911',
      subject: 'Chat pós-venda — suporte ergonômico',
      buyerName: 'thiago_almeida',
      buyerExternalId: 'bn_99112233',
      status: 'UNREAD',
      priority: 'HIGH',
      dueInMs: 7 * HOUR,
      targetInMs: 5 * HOUR,
      queue: 'SAC::Shopee-N1',
      agentKey: 'bruno',
      unread: 2,
      metadata: {
        conversation_id: 'conv_77229911',
        order_sn: '241105ABCDEFGH',
        unread_count: 2,
        crr_safe: false,
        last_message_direction: 'INBOUND_BUYER',
        tracking_number: 'SPX-9911223344',
      },
      messages: [
        {
          direction: 'OUTBOUND_AGENT',
          route: 'SHOPEE_CHAT_API',
          text: 'Olá! Seu pedido está em trânsito e chega até amanhã. Qualquer dúvida estou por aqui. 😊',
          minutesAgo: 320,
          delivery: 'READ',
          agentEmail: 'bruno@sachub.demo',
        },
        {
          direction: 'INBOUND_BUYER',
          route: 'SHOPEE_CHAT_API',
          text: 'Oi, o rastreio não atualiza desde ontem. Consegue ver com a transportadora?',
          minutesAgo: 95,
          externalId: 'shp-msg-9911',
          contentPayload: { created_timestamp: Math.floor(ago(95 * MIN).getTime() / 1000) },
        },
        {
          direction: 'INBOUND_BUYER',
          route: 'SHOPEE_CHAT_API',
          text: 'Ah, e o suporte serve para notebook de 15,6"?',
          minutesAgo: 92,
          externalId: 'shp-msg-9912',
          contentPayload: { created_timestamp: Math.floor(ago(92 * MIN).getTime() / 1000) },
        },
      ],
    },
    {
      key: 'shopee2',
      accountId: accounts.shopee!,
      marketplace: 'SHOPEE',
      ticketType: 'RETURN_REFUND',
      reference: '2409300RTN001',
      orderId: '241101ZZYXWVUT',
      orderKey: 'shopeeOrder2',
      conversationId: 'conv_66554433',
      returnSn: '2409300RTN001',
      subject: 'Devolução N2 — cabo USB-C',
      buyerName: 'patricia_lima',
      buyerExternalId: 'bn_44556677',
      hasActiveClaim: true,
      status: 'OPEN_WAITING_AGENT',
      priority: 'CRITICAL_SLA',
      dueInMs: 40 * MIN,
      targetInMs: -20 * MIN,
      queue: 'SAC::Shopee-N2-Retencao',
      agentKey: null,
      unread: 1,
      metadata: {
        return_sn: '2409300RTN001',
        order_sn: '241101ZZYXWVUT',
        return_status: 'REQUESTED',
        reason: 'ITEM_DAMAGED',
        refund_amount: 59.9,
        conversation_id: 'conv_66554433',
        crr_safe: false,
        image_evidence_required: true,
      },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'SHOPEE_RETURNS_API',
          text: 'O cabo veio com o conector torto e não carrega. Abri a devolução com foto. Quero o reembolso.',
          minutesAgo: 200,
          externalId: 'shopee-return-msg-1',
          messageType: 'image',
          attachments: [{ fileName: 'conector.jpg', mimeType: 'image/jpeg', sizeBytes: 512000 }],
          contentPayload: { return_sn: '2409300RTN001', dispute_window_hours: 48 },
        },
      ],
    },
    {
      key: 'shopee3',
      accountId: accounts.shopee!,
      marketplace: 'SHOPEE',
      ticketType: 'CANCELLATION',
      reference: '2408060CAN009',
      orderId: '241029CANCEL01',
      conversationId: 'conv_11002233',
      subject: 'Cancelamento solicitado pelo comprador',
      buyerName: 'lucas_pereira',
      buyerExternalId: 'bn_11223344',
      status: 'OPEN_WAITING_AGENT',
      priority: 'CRITICAL_SLA',
      dueInMs: 55 * MIN,
      targetInMs: 10 * MIN,
      queue: 'SAC::Shopee-N2-Retencao',
      agentKey: null,
      unread: 1,
      metadata: {
        order_sn: '241029CANCEL01',
        cancellation_reason: 'OUT_OF_STOCK',
        cancellation_initiator: 'BUYER',
        crr_safe: true,
        conversation_id: 'conv_11002233',
      },
      messages: [
        {
          direction: 'INBOUND_BUYER',
          route: 'SHOPEE_CHAT_API',
          text: 'Comprei o produto errado, podem cancelar? Ainda não foi enviado.',
          minutesAgo: 60,
          externalId: 'shp-cancel-msg-1',
        },
      ],
    },
  ];

  for (const ticket of tickets) {
    const orderCacheId = ticket.orderKey ? orders[ticket.orderKey] ?? null : null;
    const created = await prisma.supportTicket.create({
      data: {
        accountId: ticket.accountId,
        marketplace: ticket.marketplace,
        ticketType: ticket.ticketType,
        externalReferenceId: ticket.reference,
        externalOrderId: ticket.orderId ?? null,
        orderCacheId,
        packId: ticket.packId ?? null,
        claimId: ticket.claimId ?? null,
        conversationId: ticket.conversationId ?? null,
        returnSn: ticket.returnSn ?? null,
        subject: ticket.subject,
        buyerExternalId: ticket.buyerExternalId ?? null,
        buyerDisplayName: ticket.buyerName,
        buyerAnonymizedEmail: ticket.buyerEmail ?? null,
        hasActiveClaim: ticket.hasActiveClaim ?? false,
        status: ticket.status,
        priority: ticket.priority,
        slaDeadlineAt: at(ticket.dueInMs),
        slaTargetAt: ticket.targetInMs ? at(ticket.targetInMs) : null,
        slaLegMinutes: Math.round((ticket.dueInMs + 60 * MIN) / MIN),
        slaBreached: ticket.dueInMs < 0,
        slaState: ticket.dueInMs < 0 ? 'BREACHED' : ticket.dueInMs < 2 * HOUR ? 'AT_RISK' : 'ON_TRACK',
        firstResponseAt: ticket.firstResponseMinutesAgo ? ago(ticket.firstResponseMinutesAgo * MIN) : null,
        lastInboundAt: ago(ticket.messages[0]?.minutesAgo ?? 30),
        lastMessageAt: ago(ticket.messages[ticket.messages.length - 1]?.minutesAgo ?? 30),
        unreadCount: ticket.unread ?? 0,
        assignedAgentId: ticket.agentKey ? agents[ticket.agentKey] ?? null : null,
        assignedQueue: ticket.queue,
        channelMetadata: ticket.metadata,
        tags: [ticket.marketplace === 'AMAZON' ? 'amazon-relay' : ticket.marketplace === 'MERCADO_LIVRE' ? 'meli' : 'shopee'],
        isDemo: true,
      },
    });

    for (const message of ticket.messages) {
      const createdMessage = await prisma.ticketMessage.create({
        data: {
          ticketId: created.id,
          externalMessageId: message.externalId ?? null,
          direction: message.direction,
          channelRouteUsed: message.route,
          messageType: message.messageType ?? 'text',
          bodyCleanText: message.text,
          contentPayload: message.contentPayload ?? {},
          bodyRawS3Uri:
            ticket.marketplace === 'AMAZON' && message.direction === 'INBOUND_BUYER'
              ? `s3://sac-hub-raw/seed/amazon/${ticket.key}-${message.minutesAgo}.eml`
              : null,
          deliveryStatus: message.delivery ?? 'DELIVERED',
          authorAgentId: message.agentEmail
            ? agents[message.agentEmail.split('@')[0]!] ?? null
            : null,
          marketplaceCreatedAt: ago(message.minutesAgo * MIN),
          sentAt: message.direction === 'INBOUND_BUYER' ? null : ago(message.minutesAgo * MIN),
          deliveredAt: message.direction === 'INBOUND_BUYER' ? null : ago((message.minutesAgo - 1) * MIN),
          readAt: message.delivery === 'READ' ? ago((message.minutesAgo - 2) * MIN) : null,
        },
      });

      for (const attachment of message.attachments ?? []) {
        await prisma.messageAttachment.create({
          data: {
            messageId: createdMessage.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            s3Uri: `s3://sac-hub-attachments/seed/${ticket.key}/${attachment.fileName}`,
            isEvidence: true,
          },
        });
      }
    }

    await prisma.ticketEvent.createMany({
      data: [
        {
          ticketId: created.id,
          eventType: 'TICKET_CREATED',
          actorLabel: 'system',
          payload: { source: ticket.marketplace, reference: ticket.reference },
          createdAt: ago((ticket.messages[0]?.minutesAgo ?? 60) * MIN),
        },
        ...(ticket.agentKey
          ? [
              {
                ticketId: created.id,
                eventType: 'ASSIGNED',
                actorAgentId: agents[ticket.agentKey] ?? null,
                actorLabel: ticket.agentKey,
                payload: { queue: ticket.queue },
                createdAt: ago(100 * MIN),
              },
            ]
          : []),
        {
          ticketId: created.id,
          eventType: ticket.hasActiveClaim ? 'CLAIM_OPENED' : 'SLA_STARTED',
          actorLabel: 'system',
          payload: ticket.hasActiveClaim ? { claim_id: ticket.claimId, due_date: at(ticket.dueInMs).toISOString() } : { deadline: at(ticket.dueInMs).toISOString() },
          createdAt: ago(90 * MIN),
        },
      ],
    });

    if (ticket.marketplace === 'AMAZON' && ticket.key === 'amz1') {
      await prisma.buyerPiiVault.create({
        data: {
          ticketId: created.id,
          marketplace: 'AMAZON',
          buyerName: 'Camila Ferreira',
          buyerEmail: 'camila.ferreira@example.com',
          buyerDocument: '123.456.789-00',
          buyerPhone: '+55 11 98765-4321',
          shippingAddress: {
            line1: 'Rua das Acácias, 245 — apto 82',
            district: 'Vila Mariana',
            city: 'São Paulo',
            state: 'SP',
            postalCode: '04012-090',
            country: 'BR',
          },
          sourceEndpoints: ['/orders/v0/orders/123-4567890-1234567'],
          collectedAt: ago(3 * HOUR),
          expiresAt: at(27 * DAY),
        },
      });
    }
  }
}

async function seedSlaPolicies(): Promise<void> {
  // accountId is nullable, so Postgres cannot enforce the composite unique for
  // global (accountId = null) policies - use find-first semantics.
  const existing = await prisma.slaPolicy.findFirst({
    where: { accountId: null, marketplace: 'MERCADO_LIVRE', ticketType: 'CLAIM_DISPUTE' },
  });
  if (!existing) {
    await prisma.slaPolicy.create({
      data: {
        accountId: null,
        marketplace: 'MERCADO_LIVRE',
        ticketType: 'CLAIM_DISPUTE',
        firstResponseMinutes: 240,
        targetMinutes: 1440,
        warningMinutes: 240,
        businessHoursOnly: false,
        isActive: true,
      },
    });
  }
}

async function main(): Promise<void> {
  console.log('▸ Limpando dados de demonstração…');
  await resetDemoAccounts();

  console.log('▸ Operadores…');
  const agents = await seedAgents();

  console.log('▸ Lojas conectadas…');
  const accounts = await seedAccounts();

  console.log('▸ Pedidos…');
  const orders = await seedOrders(accounts);

  console.log('▸ Atendimentos, mensagens e evidências…');
  await seedTickets(accounts, orders, agents);

  console.log('▸ Políticas de SLA…');
  await seedSlaPolicies();

  const counts = {
    agents: await prisma.agent.count(),
    accounts: await prisma.marketplaceAccount.count(),
    orders: await prisma.orderCache.count(),
    tickets: await prisma.supportTicket.count(),
    messages: await prisma.ticketMessage.count(),
    attachments: await prisma.messageAttachment.count(),
  };
  console.log('✓ Seed concluído:', counts);
  console.log('  Login demo: marina@sachub.demo / sac-hub-2024');
}

main()
  .catch((error) => {
    console.error('✗ Seed falhou:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
