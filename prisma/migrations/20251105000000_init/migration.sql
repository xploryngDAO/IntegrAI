-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('AMAZON', 'MERCADO_LIVRE', 'SHOPEE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'TOKEN_EXPIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('PRE_SALE', 'POST_SALE_ORDER', 'CLAIM_DISPUTE', 'RETURN_REFUND', 'CANCELLATION', 'PROACTIVE');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('UNREAD', 'OPEN_WAITING_AGENT', 'WAITING_BUYER', 'NO_RESPONSE_NEEDED', 'MEDIATION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL_SLA');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND_BUYER', 'OUTBOUND_AGENT', 'OUTBOUND_SYSTEM', 'EXTERNAL_SELLER_PANEL', 'MEDIATOR');

-- CreateEnum
CREATE TYPE "ChannelRoute" AS ENUM ('AMAZON_EMAIL_RELAY', 'AMAZON_SP_API_MESSAGING', 'MELI_QUESTIONS_API', 'MELI_MESSAGES_API', 'MELI_CLAIMS_API', 'SHOPEE_CHAT_API', 'SHOPEE_RETURNS_API');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'BOUNCED_BLOCKED', 'MODERATION_REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentPresenceStatus" AS ENUM ('ONLINE', 'PAUSED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('ADMIN', 'SUPERVISOR', 'AGENT');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'DUPLICATE', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('ON_TRACK', 'AT_RISK', 'BREACHED', 'MET');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "email" VARCHAR(180) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "AgentRole" NOT NULL DEFAULT 'AGENT',
    "presence" "AgentPresenceStatus" NOT NULL DEFAULT 'OFFLINE',
    "avatar_color" VARCHAR(16) NOT NULL DEFAULT '#2563eb',
    "max_concurrent" INTEGER NOT NULL DEFAULT 20,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_accounts" (
    "id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "external_seller_id" VARCHAR(128) NOT NULL,
    "marketplace_site_id" VARCHAR(32) NOT NULL,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "auth_expires_at" TIMESTAMPTZ(6),
    "channel_config" JSONB NOT NULL DEFAULT '{}',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_token_refresh_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketplace_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders_cache" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "external_order_id" VARCHAR(128) NOT NULL,
    "pack_id" VARCHAR(128),
    "buyer_external_id" VARCHAR(128),
    "buyer_name_or_nick" VARCHAR(180),
    "buyer_anonymized_email" VARCHAR(180),
    "order_status" VARCHAR(64) NOT NULL,
    "fulfillment_type" VARCHAR(64),
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'BRL',
    "tracking_number" VARCHAR(120),
    "carrier_name" VARCHAR(120),
    "items_snapshot" JSONB NOT NULL DEFAULT '[]',
    "allowed_actions_cache" JSONB NOT NULL DEFAULT '{}',
    "shipping_snapshot" JSONB NOT NULL DEFAULT '{}',
    "estimated_delivery_at" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "ticket_type" "TicketType" NOT NULL,
    "external_reference_id" VARCHAR(180) NOT NULL,
    "external_order_id" VARCHAR(128),
    "order_cache_id" UUID,
    "pack_id" VARCHAR(128),
    "claim_id" VARCHAR(128),
    "conversation_id" VARCHAR(128),
    "return_sn" VARCHAR(128),
    "subject" VARCHAR(400),
    "buyer_external_id" VARCHAR(180),
    "buyer_display_name" VARCHAR(180),
    "buyer_anonymized_email" VARCHAR(180),
    "buyer_contact_hash" VARCHAR(128),
    "has_active_claim" BOOLEAN NOT NULL DEFAULT false,
    "status" "TicketStatus" NOT NULL DEFAULT 'UNREAD',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "sla_deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "sla_target_at" TIMESTAMPTZ(6),
    "sla_leg_minutes" INTEGER,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "sla_state" "SlaState" NOT NULL DEFAULT 'ON_TRACK',
    "first_response_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "last_inbound_at" TIMESTAMPTZ(6),
    "last_outbound_at" TIMESTAMPTZ(6),
    "last_message_at" TIMESTAMPTZ(6),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "assigned_agent_id" UUID,
    "assigned_queue" VARCHAR(80),
    "channel_metadata" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "external_message_id" VARCHAR(400),
    "in_reply_to_id" VARCHAR(400),
    "references_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "direction" "MessageDirection" NOT NULL,
    "channel_route_used" "ChannelRoute" NOT NULL,
    "message_type" VARCHAR(32) NOT NULL DEFAULT 'text',
    "body_clean_text" TEXT NOT NULL DEFAULT '',
    "body_html" TEXT,
    "content_payload" JSONB NOT NULL DEFAULT '{}',
    "body_raw_s3_uri" VARCHAR(512),
    "delivery_status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "error_detail" TEXT,
    "is_internal_note" BOOLEAN NOT NULL DEFAULT false,
    "author_agent_id" UUID,
    "marketplace_created_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" VARCHAR(64),
    "s3_uri" VARCHAR(512) NOT NULL,
    "external_upload_id" VARCHAR(255),
    "is_evidence" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_pii_vault" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "buyer_name" VARCHAR(255),
    "buyer_email" VARCHAR(255),
    "buyer_document" VARCHAR(64),
    "buyer_phone" VARCHAR(64),
    "shipping_address" JSONB NOT NULL DEFAULT '{}',
    "source_endpoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "purged_at" TIMESTAMPTZ(6),

    CONSTRAINT "buyer_pii_vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "actor_agent_id" UUID,
    "actor_label" VARCHAR(120),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_attempts" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "message_id" UUID,
    "channel_route" "ChannelRoute" NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "request_payload" JSONB NOT NULL DEFAULT '{}',
    "response_payload" JSONB NOT NULL DEFAULT '{}',
    "http_status" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error_code" VARCHAR(96),
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "account_id" UUID,
    "event_id" VARCHAR(255),
    "topic" VARCHAR(120),
    "resource" VARCHAR(512),
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "signature_valid" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payload_s3_uri" VARCHAR(512),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "marketplace" "Marketplace" NOT NULL,
    "ticket_type" "TicketType" NOT NULL,
    "first_response_minutes" INTEGER NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "warning_minutes" INTEGER NOT NULL DEFAULT 120,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_email_key" ON "agents"("email");

-- CreateIndex
CREATE INDEX "marketplace_accounts_marketplace_status_idx" ON "marketplace_accounts"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_accounts_marketplace_external_seller_id_marketp_key" ON "marketplace_accounts"("marketplace", "external_seller_id", "marketplace_site_id");

-- CreateIndex
CREATE INDEX "orders_cache_marketplace_order_status_idx" ON "orders_cache"("marketplace", "order_status");

-- CreateIndex
CREATE INDEX "orders_cache_tracking_number_idx" ON "orders_cache"("tracking_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cache_account_id_external_order_id_key" ON "orders_cache"("account_id", "external_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cache_marketplace_external_order_id_key" ON "orders_cache"("marketplace", "external_order_id");

-- CreateIndex
CREATE INDEX "support_tickets_sla_deadline_at_status_idx" ON "support_tickets"("sla_deadline_at", "status");

-- CreateIndex
CREATE INDEX "support_tickets_status_priority_sla_deadline_at_idx" ON "support_tickets"("status", "priority", "sla_deadline_at");

-- CreateIndex
CREATE INDEX "support_tickets_external_reference_id_idx" ON "support_tickets"("external_reference_id");

-- CreateIndex
CREATE INDEX "support_tickets_marketplace_ticket_type_idx" ON "support_tickets"("marketplace", "ticket_type");

-- CreateIndex
CREATE INDEX "support_tickets_account_id_status_idx" ON "support_tickets"("account_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_external_order_id_idx" ON "support_tickets"("external_order_id");

-- CreateIndex
CREATE INDEX "support_tickets_assigned_agent_id_status_idx" ON "support_tickets"("assigned_agent_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_buyer_anonymized_email_idx" ON "support_tickets"("buyer_anonymized_email");

-- CreateIndex
CREATE INDEX "support_tickets_claim_id_idx" ON "support_tickets"("claim_id");

-- CreateIndex
CREATE INDEX "support_tickets_conversation_id_idx" ON "support_tickets"("conversation_id");

-- CreateIndex
CREATE INDEX "support_tickets_last_message_at_idx" ON "support_tickets"("last_message_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_marketplace_created_at_idx" ON "ticket_messages"("ticket_id", "marketplace_created_at");

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_direction_idx" ON "ticket_messages"("ticket_id", "direction");

-- CreateIndex
CREATE INDEX "ticket_messages_in_reply_to_id_idx" ON "ticket_messages"("in_reply_to_id");

-- CreateIndex
CREATE INDEX "ticket_messages_delivery_status_idx" ON "ticket_messages"("delivery_status");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_messages_external_message_id_key" ON "ticket_messages"("external_message_id");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_pii_vault_ticket_id_key" ON "buyer_pii_vault"("ticket_id");

-- CreateIndex
CREATE INDEX "buyer_pii_vault_expires_at_idx" ON "buyer_pii_vault"("expires_at");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_attempts_ticket_id_created_at_idx" ON "outbound_attempts"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_attempts_channel_route_status_idx" ON "outbound_attempts"("channel_route", "status");

-- CreateIndex
CREATE INDEX "webhook_events_marketplace_received_at_idx" ON "webhook_events"("marketplace", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_marketplace_event_id_key" ON "webhook_events"("marketplace", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_account_id_marketplace_ticket_type_key" ON "sla_policies"("account_id", "marketplace", "ticket_type");

-- AddForeignKey
ALTER TABLE "orders_cache" ADD CONSTRAINT "orders_cache_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_cache_id_fkey" FOREIGN KEY ("order_cache_id") REFERENCES "orders_cache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyer_pii_vault" ADD CONSTRAINT "buyer_pii_vault_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_agent_id_fkey" FOREIGN KEY ("actor_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

