-- Migración: webhook Tpaga, reconciliación persistente, notificaciones, caché bancos
-- Las órdenes existentes NO reciben payment_method='PSE' por defecto.

-- AlterTable orders (payment_method nullable, sin DEFAULT)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_method" TEXT;
ALTER TABLE "orders" ALTER COLUMN "payment_method" DROP DEFAULT;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tpaga_status" TEXT;

-- Notificaciones con estado explícito (no usar sent_at como claim)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmation_email_status" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmation_email_claimed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmation_email_sent_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmation_email_last_error" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmation_email_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_notification_status" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_notification_claimed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_notification_sent_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_notification_last_error" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_notification_attempts" INTEGER NOT NULL DEFAULT 0;

-- Limpiar columnas obsoletas si existían en un deploy previo
ALTER TABLE "orders" DROP COLUMN IF EXISTS "user_notified_at";

-- CreateTable tpaga_webhook_events
CREATE TABLE IF NOT EXISTS "tpaga_webhook_events" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "charge_token" TEXT NOT NULL,
    "status" TEXT,
    "order_id" TEXT,
    "processing_status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processing_error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tpaga_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tpaga_webhook_events_idempotency_key_key" ON "tpaga_webhook_events"("idempotency_key");
CREATE INDEX IF NOT EXISTS "tpaga_webhook_events_charge_token_idx" ON "tpaga_webhook_events"("charge_token");

-- CreateTable tpaga_reconciliations
CREATE TABLE IF NOT EXISTS "tpaga_reconciliations" (
    "id" TEXT NOT NULL,
    "charge_token" TEXT NOT NULL,
    "order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "webhook_event_id" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tpaga_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tpaga_reconciliations_charge_token_key" ON "tpaga_reconciliations"("charge_token");
CREATE INDEX IF NOT EXISTS "tpaga_reconciliations_status_next_attempt_at_idx" ON "tpaga_reconciliations"("status", "next_attempt_at");

-- CreateTable pse_bank_cache
CREATE TABLE IF NOT EXISTS "pse_bank_cache" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "banks" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pse_bank_cache_pkey" PRIMARY KEY ("id")
);
