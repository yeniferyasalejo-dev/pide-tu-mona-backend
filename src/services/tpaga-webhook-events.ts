import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export type WebhookProcessingStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

export type RegisterWebhookEventResult =
  | { kind: "new"; eventId: string; processingStatus: WebhookProcessingStatus }
  | { kind: "duplicate"; eventId: string; processingStatus: WebhookProcessingStatus };

/**
 * Registra la recepción del webhook (idempotencia de notificación).
 * No implica que el pago ya fue procesado.
 */
export async function registerWebhookEvent(params: {
  idempotencyKey: string;
  chargeToken: string;
  status: string | null;
  orderId: string | null;
}): Promise<RegisterWebhookEventResult> {
  try {
    const event = await prisma.tpagaWebhookEvent.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        chargeToken: params.chargeToken,
        status: params.status,
        orderId: params.orderId,
        processingStatus: "RECEIVED",
      },
    });

    return {
      kind: "new",
      eventId: event.id,
      processingStatus: event.processingStatus as WebhookProcessingStatus,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.tpagaWebhookEvent.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
        select: { id: true, processingStatus: true },
      });

      if (existing) {
        return {
          kind: "duplicate",
          eventId: existing.id,
          processingStatus: existing.processingStatus as WebhookProcessingStatus,
        };
      }
    }

    throw error;
  }
}

export async function markWebhookEventProcessing(
  eventId: string
): Promise<boolean> {
  const result = await prisma.tpagaWebhookEvent.updateMany({
    where: {
      id: eventId,
      processingStatus: { in: ["RECEIVED", "FAILED"] },
    },
    data: { processingStatus: "PROCESSING", processingError: null },
  });
  return result.count > 0;
}

export async function markWebhookEventProcessed(
  eventId: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const client = tx ?? prisma;
  await client.tpagaWebhookEvent.updateMany({
    where: { id: eventId, processingStatus: { not: "PROCESSED" } },
    data: {
      processingStatus: "PROCESSED",
      processedAt: new Date(),
      processingError: null,
    },
  });
}

export async function markWebhookEventFailed(
  eventId: string,
  errorMessage: string
): Promise<void> {
  await prisma.tpagaWebhookEvent.updateMany({
    where: { id: eventId, processingStatus: { not: "PROCESSED" } },
    data: {
      processingStatus: "FAILED",
      processingError: errorMessage.substring(0, 500),
    },
  });
}

export function isWebhookEventProcessed(
  processingStatus: WebhookProcessingStatus
): boolean {
  return processingStatus === "PROCESSED";
}

export function canRetryWebhookProcessing(
  processingStatus: WebhookProcessingStatus
): boolean {
  return (
    processingStatus === "RECEIVED" ||
    processingStatus === "FAILED" ||
    processingStatus === "PROCESSING"
  );
}
