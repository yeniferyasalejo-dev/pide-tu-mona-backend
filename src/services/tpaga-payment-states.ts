/**
 * Estados de cobro PSE según documentación Tpaga
 * (https://api-pse.docs.tpaga.co/).
 *
 * REGLA DE NEGOCIO:
 * - Solo `settled` ejecuta settleOrderPayment (inventario + PAID).
 * - Estados transitorios solo actualizan tpaga_status (informativo).
 * - Solo estados finales negativos ejecutan rejectOrderPayment.
 */

export type TpagaChargeStatus =
  | "pending"
  | "created"
  | "processing"
  | "authorized"
  | "settled"
  | "charge-rejected"
  | "rejected"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type PaymentOutcome =
  | "confirmed" // → settleOrderPayment
  | "rejected" // → rejectOrderPayment
  | "pending" // → solo tpaga_status
  | "ignored"; // → sin cambio de orden

/** Acción de negocio asociada a cada estado normalizado */
export type TpagaStatusAction =
  | "settleOrderPayment"
  | "rejectOrderPayment"
  | "informative";

export const TPAGA_STATUS_ACTION_MAP: Record<TpagaChargeStatus, TpagaStatusAction> =
  {
    settled: "settleOrderPayment",
    pending: "informative",
    created: "informative",
    processing: "informative",
    authorized: "informative",
    "charge-rejected": "rejectOrderPayment",
    rejected: "rejectOrderPayment",
    failed: "rejectOrderPayment",
    cancelled: "rejectOrderPayment",
    expired: "rejectOrderPayment",
    unknown: "informative",
  };

export function normalizeTpagaStatus(
  raw: string | null | undefined
): TpagaChargeStatus {
  const value = (raw ?? "").trim().toLowerCase();
  switch (value) {
    case "pending":
      return "pending";
    case "created":
      return "created";
    case "processing":
      return "processing";
    case "authorized":
      return "authorized";
    case "settled":
      return "settled";
    case "charge-rejected":
      return "charge-rejected";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return value ? "unknown" : "unknown";
  }
}

export function getTpagaStatusAction(
  status: TpagaChargeStatus
): TpagaStatusAction {
  return TPAGA_STATUS_ACTION_MAP[status];
}

export function classifyPaymentOutcome(status: TpagaChargeStatus): PaymentOutcome {
  const action = getTpagaStatusAction(status);
  if (action === "settleOrderPayment") return "confirmed";
  if (action === "rejectOrderPayment") return "rejected";
  if (
    status === "pending" ||
    status === "created" ||
    status === "processing" ||
    status === "authorized"
  ) {
    return "pending";
  }
  return "ignored";
}

export function isFinalNegativeTpagaStatus(status: TpagaChargeStatus): boolean {
  return getTpagaStatusAction(status) === "rejectOrderPayment";
}

export function isSettledTpagaStatus(status: TpagaChargeStatus): boolean {
  return status === "settled";
}
