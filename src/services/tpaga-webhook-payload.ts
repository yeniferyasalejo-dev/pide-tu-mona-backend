import { normalizeTpagaStatus } from "./tpaga-payment-states";

export interface ParsedTpagaWebhookPayload {
  chargeToken: string;
  status: string | null;
  normalizedStatus: ReturnType<typeof normalizeTpagaStatus>;
  orderId: string | null;
  rejectedReason: string | null;
  transactionState: string | null;
  traceabilityCode: string | null;
  eventId: string | null;
  /** Campos presentes en el body (sin valores sensibles) para diagnóstico */
  receivedFields: string[];
}

function readString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Normaliza el body del webhook de Tpaga.
 * Documentación oficial: solo envía `charge_token`; aceptamos campos
 * adicionales si Tpaga o un proxy los incluyen (status, order_id, etc.).
 */
export function parseTpagaWebhookBody(body: unknown): ParsedTpagaWebhookPayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const receivedFields = Object.keys(record).sort();

  const chargeToken = readString(record, [
    "charge_token",
    "chargeToken",
    "token",
  ]);

  if (!chargeToken) {
    return null;
  }

  const status = readString(record, ["status", "charge_status", "chargeStatus"]);
  const orderId = readString(record, ["order_id", "orderId"]);
  const rejectedReason = readString(record, [
    "rejected_reason",
    "rejectedReason",
    "rejection_reason",
  ]);
  const transactionState = readString(record, [
    "transaction_state",
    "transactionState",
  ]);
  const traceabilityCode = readString(record, [
    "traceability_code",
    "traceabilityCode",
  ]);
  const eventId = readString(record, [
    "event_id",
    "eventId",
    "id",
    "notification_id",
  ]);

  return {
    chargeToken,
    status,
    normalizedStatus: normalizeTpagaStatus(status),
    orderId,
    rejectedReason,
    transactionState,
    traceabilityCode,
    eventId,
    receivedFields,
  };
}

export function buildWebhookIdempotencyKey(
  payload: ParsedTpagaWebhookPayload
): string {
  if (payload.eventId) {
    return `event:${payload.eventId}`;
  }

  if (payload.status) {
    return `${payload.chargeToken}:${payload.status.toLowerCase()}`;
  }

  return `${payload.chargeToken}:notification`;
}
