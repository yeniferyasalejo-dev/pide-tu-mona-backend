import { Request } from "express";
import {
  buildWebhookIdempotencyKey,
  parseTpagaWebhookBody,
} from "./tpaga-webhook-payload";
import {
  registerWebhookEvent,
  isWebhookEventProcessed,
  canRetryWebhookProcessing,
} from "./tpaga-webhook-events";
import { processPaymentFromStatus } from "./payment-processor";
import { enqueueReconciliation } from "./tpaga-reconciliation";
import { logTpagaWebhookInfo, logTpagaWebhookError } from "./tpaga-webhook-logger";
import { findOrderByTpagaToken } from "./users";

/**
 * TPAGA_WEBHOOK_SECRET está desactivado por defecto (cadena vacía / variable ausente).
 * Solo se valida el header cuando la variable está definida y no vacía.
 */
function getWebhookSecret(): string | null {
  const value = process.env.TPAGA_WEBHOOK_SECRET;
  if (!value || !value.trim()) {
    return null;
  }
  return value.trim();
}

/**
 * Tpaga PSE no documenta firma HMAC en el webhook.
 * Validación opcional vía header compartido solo si TPAGA_WEBHOOK_SECRET está configurado.
 */
export function isTpagaWebhookAuthorized(req: Request): boolean {
  const secret = getWebhookSecret();
  if (!secret) {
    return true;
  }

  const header =
    req.headers["x-tpaga-webhook-secret"] ||
    req.headers["x-webhook-secret"];

  return typeof header === "string" && header === secret;
}

export type WebhookAcceptResult =
  | { ok: true; chargeToken: string; duplicate: boolean }
  | { ok: false; statusCode: number; body: Record<string, unknown> };

/**
 * Valida y registra la recepción del evento. Responder HTTP 200 después de esto.
 */
export async function acceptTpagaWebhook(
  body: unknown,
  authorized: boolean
): Promise<WebhookAcceptResult> {
  if (!authorized) {
    logTpagaWebhookError("unauthorized", {});
    return {
      ok: false,
      statusCode: 401,
      body: { received: false, error: "unauthorized" },
    };
  }

  const payload = parseTpagaWebhookBody(body);
  if (!payload) {
    logTpagaWebhookError("invalid_payload", {
      receivedFields:
        body && typeof body === "object" && !Array.isArray(body)
          ? Object.keys(body as Record<string, unknown>).sort()
          : [],
      error: "charge_token is required",
    });
    return {
      ok: false,
      statusCode: 400,
      body: { received: false, error: "charge_token is required" },
    };
  }

  const idempotencyKey = buildWebhookIdempotencyKey(payload);

  logTpagaWebhookInfo("notification_received", {
    chargeToken: payload.chargeToken,
    status: payload.status,
    orderId: payload.orderId,
    idempotencyKey,
    receivedFields: payload.receivedFields,
    source: "webhook",
  });

  const registration = await registerWebhookEvent({
    idempotencyKey,
    chargeToken: payload.chargeToken,
    status: payload.status,
    orderId: payload.orderId,
  });

  const isDuplicate = registration.kind === "duplicate";

  if (isDuplicate) {
    logTpagaWebhookInfo("duplicate_event", {
      chargeToken: payload.chargeToken,
      status: payload.status,
      idempotencyKey,
      duplicate: true,
      source: "webhook",
    });
  }

  void dispatchWebhookProcessing({
    payload,
    eventId: registration.eventId,
    processingStatus: registration.processingStatus,
    isDuplicate,
  }).catch((error) => {
    logTpagaWebhookError(
      "background_dispatch_failed",
      {
        chargeToken: payload.chargeToken,
        status: payload.status,
        orderId: payload.orderId,
        source: "webhook",
      },
      error
    );
  });

  return {
    ok: true,
    chargeToken: payload.chargeToken,
    duplicate: isDuplicate,
  };
}

async function dispatchWebhookProcessing(params: {
  payload: NonNullable<ReturnType<typeof parseTpagaWebhookBody>>;
  eventId: string;
  processingStatus: import("./tpaga-webhook-events").WebhookProcessingStatus;
  isDuplicate: boolean;
}): Promise<void> {
  const { payload, eventId, processingStatus, isDuplicate } = params;

  if (!payload.status) {
    await enqueueReconciliation({
      chargeToken: payload.chargeToken,
      orderId: payload.orderId,
      webhookEventId: eventId,
      immediate: true,
    });
    return;
  }

  if (isDuplicate && isWebhookEventProcessed(processingStatus)) {
    const order = await findOrderByTpagaToken(payload.chargeToken);
    const orderStillOpen =
      order &&
      order.status !== "PAID" &&
      order.status !== "FAILED" &&
      order.paymentMethod !== "COD";

    if (orderStillOpen) {
      await enqueueReconciliation({
        chargeToken: payload.chargeToken,
        orderId: order.id,
        webhookEventId: eventId,
      });
    }
    return;
  }

  if (isDuplicate && !canRetryWebhookProcessing(processingStatus)) {
    return;
  }

  if (isDuplicate && processingStatus === "PROCESSED") {
    return;
  }

  await processPaymentFromStatus({
    chargeToken: payload.chargeToken,
    status: payload.status,
    rejectedReason: payload.rejectedReason,
    orderIdHint: payload.orderId,
    source: "webhook",
    webhookEventId: eventId,
  });
}
