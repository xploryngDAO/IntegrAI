import type { BuyerPiiSnapshot, NormalizedOrderSnapshot } from '@sac/shared';

/**
 * Amazon adapter internal types.
 *
 * All SP-API / relay payloads are decoded from `unknown` into these shapes; the
 * adapter never trusts a field to exist (Amazon omits optional members freely),
 * so every consumer still goes through the guards in `guards.ts`.
 */

/** Any decoded JSON object. */
export type JsonRecord = Record<string, unknown>;

/** Amazon-specific keys read from `marketplace_accounts.channel_config`. */
export interface AmazonAccountSettings {
  /** `inbound_email_route` may be a single address or a list of aliases. */
  inboundEmailRoutes: string[];
  /** `smtp_sender_email`: the approved Buyer-Seller relay From address. */
  smtpSenderEmail: string | null;
  /** `approved_sender_domains`: seller domains that may reply from the panel. */
  approvedSenderDomains: string[];
  sellerCentralRegion: string | null;
  /** `allowed_actions_cache`: last known `getMessagingActionsForOrder` result. */
  allowedActionsCache: string[];
}

/**
 * Normalized SES inbound relay payload (JSON form). For raw `message/rfc822`
 * posts the same shape is synthesized from the MIME headers.
 */
export interface SesRelayPayload {
  messageId: string;
  envelopeFrom: string | null;
  envelopeTo: string | null;
  headers: Record<string, string>;
  rawMimeBase64: string;
  receivedAt: string | null;
}

/** Kind of Amazon system notice sender detected in an inbound relay message. */
export type SystemSenderKind = 'bounce' | 'blocked' | 'tracking' | 'notification';

export type OrderIdSource = 'header' | 'subject' | 'body';

/* ==========================================================================
 * SP-API Orders payloads (only the members the adapter consumes)
 * ========================================================================== */

export interface AmazonMoney {
  Amount?: string;
  CurrencyCode?: string;
  [key: string]: unknown;
}

export interface AmazonBuyerTaxClassification {
  ClassificationName?: string;
  ClassificationValue?: string;
  [key: string]: unknown;
}

export interface AmazonBuyerTaxInfo {
  CompanyLegalName?: string;
  TaxingRegion?: string;
  TaxClassifications?: AmazonBuyerTaxClassification[];
  [key: string]: unknown;
}

export interface AmazonBuyerInfo {
  BuyerEmail?: string;
  BuyerName?: string;
  BuyerCounty?: string;
  BuyerTaxInfo?: AmazonBuyerTaxInfo;
  PurchaseOrderNumber?: string;
  [key: string]: unknown;
}

/** Amazon restricted PII object (only available with an RDT). */
export interface AmazonShippingAddress {
  Name?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  City?: string;
  County?: string;
  District?: string;
  StateOrRegion?: string;
  PostalCode?: string;
  CountryCode?: string;
  Phone?: string;
  [key: string]: unknown;
}

export interface AmazonFulfillmentJson {
  TrackingNumber?: string;
  CarrierName?: string;
  ShipDate?: string;
  [key: string]: unknown;
}

export interface AmazonOrderJson {
  AmazonOrderId?: string;
  OrderStatus?: string;
  FulfillmentChannel?: string;
  SalesChannel?: string;
  OrderTotal?: AmazonMoney;
  NumberOfItems?: number;
  ShippingAddress?: AmazonShippingAddress;
  BuyerInfo?: AmazonBuyerInfo;
  PurchaseDate?: string;
  LastUpdateDate?: string;
  OrderType?: string;
  ShipServiceLevel?: string;
  ShipmentServiceLevelCategory?: string;
  MarketplaceId?: string;
  ShipDate?: string;
  DeliveryDate?: string;
  ActualDeliveryDate?: string;
  EarliestShipDate?: string;
  LatestShipDate?: string;
  EarliestDeliveryDate?: string;
  LatestDeliveryDate?: string;
  TrackingNumber?: string;
  ShipmentTrackingNumber?: string;
  CarrierName?: string;
  Fulfillment?: AmazonFulfillmentJson;
  [key: string]: unknown;
}

export interface AmazonOrderItemJson {
  ASIN?: string;
  SellerSKU?: string;
  OrderItemId?: string;
  Title?: string;
  QuantityOrdered?: number;
  QuantityShipped?: number;
  ItemPrice?: AmazonMoney;
  ShippingPrice?: AmazonMoney;
  [key: string]: unknown;
}

/** LWA token endpoint response (success or error). */
export interface LwaTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

/** Restricted Data Token endpoint response. */
export interface RdtTokenResponse {
  restrictedDataToken?: string;
  expiresIn?: number;
  [key: string]: unknown;
}

/** `POST /uploads/2020-11-01/uploadDestinations/{resource}` response (payload-wrapped). */
export interface AmazonUploadDestination {
  uploadDestinationId: string;
  url: string;
  /** Headers that MUST be sent with the presigned S3 PUT (returned by Amazon). */
  headers: Record<string, string>;
}

/** Everything the adapter needs to materialize one inbound e-mail. */
export interface AmazonOrderBundle {
  order: NormalizedOrderSnapshot;
  buyerPii: BuyerPiiSnapshot | null;
  allowedActions: string[];
  warnings: string[];
  rawOrder: AmazonOrderJson;
}
