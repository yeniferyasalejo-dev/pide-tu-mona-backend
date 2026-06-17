type WebhookLogFields = {
  chargeToken?: string | null;
  status?: string | null;
  orderId?: string | null;
  idempotencyKey?: string | null;
  source?: string;
  receivedFields?: string[];
  error?: string;
  duplicate?: boolean;
  reason?: string;
};

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatFields(fields: WebhookLogFields): string {
  const parts = [
    `at=${formatTimestamp()}`,
    fields.source ? `source=${fields.source}` : null,
    fields.chargeToken ? `chargeToken=${fields.chargeToken}` : null,
    fields.status ? `status=${fields.status}` : null,
    fields.orderId ? `orderId=${fields.orderId}` : null,
    fields.idempotencyKey ? `idempotencyKey=${fields.idempotencyKey}` : null,
    fields.receivedFields?.length
      ? `fields=${fields.receivedFields.join(",")}`
      : null,
    fields.duplicate ? "duplicate=true" : null,
    fields.error ? `error=${fields.error}` : null,
    fields.reason ? `reason=${fields.reason}` : null,
  ].filter(Boolean);

  return parts.join(" ");
}

export function logTpagaWebhookInfo(
  event: string,
  fields: WebhookLogFields = {}
): void {
  console.log(`[Tpaga Webhook] ${event} ${formatFields(fields)}`);
}

export function logTpagaWebhookError(
  event: string,
  fields: WebhookLogFields = {},
  error?: unknown
): void {
  const message =
    error instanceof Error ? error.message : error ? String(error) : fields.error;

  console.error(
    `[Tpaga Webhook] ${event} ${formatFields({ ...fields, error: message })}`
  );

  if (error instanceof Error && error.stack) {
    console.error(`[Tpaga Webhook] stack ${error.stack}`);
  }
}
