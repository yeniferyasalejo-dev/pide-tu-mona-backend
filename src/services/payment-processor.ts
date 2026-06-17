import {
  findOrderByTpagaToken,
  settleOrderPayment,
  rejectOrderPayment,
  updateOrderTpagaStatusIfOpen,
  updateUserStep,
  OrderAlreadySettledError,
} from "./users";
import { sendPurchaseConfirmation } from "./email";
import {
  isBenignChatSkip,
  sendUserChatMessage,
} from "./user-messaging";
import {
  classifyPaymentOutcome,
  normalizeTpagaStatus,
  getTpagaStatusAction,
  type TpagaChargeStatus,
} from "./tpaga-payment-states";
import { logTpagaWebhookInfo, logTpagaWebhookError } from "./tpaga-webhook-logger";
import {
  markWebhookEventProcessing,
  markWebhookEventFailed,
} from "./tpaga-webhook-events";
import {
  claimConfirmationEmailProcessing,
  markConfirmationEmailSent,
  markConfirmationEmailFailed,
  claimUserChatNotificationProcessing,
  markUserChatNotificationSent,
  markUserChatNotificationFailed,
} from "./order-notifications";
import prisma from "../lib/prisma";

export type PaymentProcessSource = "webhook" | "reconciliation";

export interface ProcessPaymentFromStatusParams {
  chargeToken: string;
  status: string;
  rejectedReason?: string | null;
  orderIdHint?: string | null;
  source: PaymentProcessSource;
  webhookEventId?: string;
}

async function markReconciliationCompleted(chargeToken: string): Promise<void> {
  await prisma.tpagaReconciliation.updateMany({
    where: {
      chargeToken,
      status: { not: "COMPLETED" },
    },
    data: {
      status: "COMPLETED",
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

/**
 * Procesa un cambio de estado usando datos ya conocidos (webhook o reconciliación).
 */
export async function processPaymentFromStatus(
  params: ProcessPaymentFromStatusParams
): Promise<boolean> {
  const normalizedStatus = normalizeTpagaStatus(params.status);
  const outcome = classifyPaymentOutcome(normalizedStatus);
  const action = getTpagaStatusAction(normalizedStatus);

  if (params.webhookEventId && params.source === "webhook") {
    await markWebhookEventProcessing(params.webhookEventId);
  }

  logTpagaWebhookInfo("payment_status_processing", {
    chargeToken: params.chargeToken,
    status: normalizedStatus,
    orderId: params.orderIdHint ?? undefined,
    source: params.source,
  });

  const order = await findOrderByTpagaToken(params.chargeToken);
  if (!order) {
    logTpagaWebhookError("order_not_found", {
      chargeToken: params.chargeToken,
      status: normalizedStatus,
      source: params.source,
    });
    if (params.webhookEventId) {
      await markWebhookEventFailed(params.webhookEventId, "order_not_found");
    }
    return false;
  }

  if (order.paymentMethod === "COD") {
    logTpagaWebhookInfo("skipped_cod_order", {
      chargeToken: params.chargeToken,
      orderId: order.id,
      source: params.source,
    });
    await markReconciliationCompleted(params.chargeToken);
    return true;
  }

  // PAID definitivo: idempotente, sin re-procesar
  if (order.status === "PAID") {
    await markReconciliationCompleted(params.chargeToken);
    return true;
  }

  // FAILED puede recuperarse si llega settled
  if (order.status === "FAILED" && outcome !== "confirmed") {
    await updateOrderTpagaStatusIfOpen(order.id, normalizedStatus);
    await markReconciliationCompleted(params.chargeToken);
    return true;
  }

  if (action === "informative" || outcome === "pending" || outcome === "ignored") {
    await updateOrderTpagaStatusIfOpen(order.id, normalizedStatus);
    logTpagaWebhookInfo(
      outcome === "pending" ? "payment_still_pending" : "payment_status_informative",
      {
        chargeToken: params.chargeToken,
        status: normalizedStatus,
        orderId: order.id,
        source: params.source,
      }
    );
    return false;
  }

  const stickerCodes = order.items.map((item) => item.stickerCode);
  const name = order.user.name || "amigo";

  try {
    if (outcome === "confirmed") {
      const result = await handleConfirmedPayment({
        order,
        chargeToken: params.chargeToken,
        stickerCodes,
        name,
        normalizedStatus,
        webhookEventId: params.webhookEventId,
        source: params.source,
      });
      if (result) {
        await markReconciliationCompleted(params.chargeToken);
      }
      return result;
    }

    if (outcome === "rejected") {
      const result = await handleRejectedPayment({
        order,
        chargeToken: params.chargeToken,
        name,
        normalizedStatus,
        rejectedReason: params.rejectedReason ?? null,
        webhookEventId: params.webhookEventId,
        source: params.source,
      });
      if (result) {
        await markReconciliationCompleted(params.chargeToken);
      }
      return result;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (params.webhookEventId) {
      await markWebhookEventFailed(params.webhookEventId, message);
    }
    logTpagaWebhookError(
      "payment_processing_failed",
      {
        chargeToken: params.chargeToken,
        orderId: order.id,
        source: params.source,
      },
      error
    );
    return false;
  }
}

async function handleConfirmedPayment(params: {
  order: NonNullable<Awaited<ReturnType<typeof findOrderByTpagaToken>>>;
  chargeToken: string;
  stickerCodes: string[];
  name: string;
  normalizedStatus: string;
  webhookEventId?: string;
  source: PaymentProcessSource;
}): Promise<boolean> {
  const { order } = params;

  let discounted: string[] = [];
  let outOfStock: string[] = [];

  try {
    const settlement = await settleOrderPayment(
      order.id,
      order.userId,
      params.stickerCodes,
      {
        tpagaStatus: params.normalizedStatus,
        webhookEventId: params.webhookEventId,
      }
    );

    if (!settlement.settled) {
      logTpagaWebhookInfo("order_already_settled", {
        chargeToken: params.chargeToken,
        orderId: order.id,
        source: params.source,
      });
      return true;
    }

    discounted = settlement.discounted;
    outOfStock = settlement.outOfStock;
  } catch (error) {
    if (error instanceof OrderAlreadySettledError) {
      logTpagaWebhookInfo("order_already_settled", {
        chargeToken: params.chargeToken,
        orderId: order.id,
        source: params.source,
      });
      return true;
    }
    throw error;
  }

  if (order.user.email) {
    const claimed = await claimConfirmationEmailProcessing(order.id);
    if (claimed) {
      try {
        await sendPurchaseConfirmation({
          to: order.user.email,
          buyerName: params.name,
          orderId: order.id,
          stickers: discounted,
          totalAmount: order.totalAmount,
          deliveryAddress: order.deliveryAddress || undefined,
          whatsappPhone: order.user.whatsappPhone || undefined,
        });
        await markConfirmationEmailSent(order.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markConfirmationEmailFailed(order.id, message);
        logTpagaWebhookError(
          "confirmation_email_failed",
          {
            chargeToken: params.chargeToken,
            orderId: order.id,
            source: params.source,
          },
          error
        );
      }
    }
  }

  const notifyClaimed = await claimUserChatNotificationProcessing(order.id, "PAID");
  if (notifyClaimed) {
    let msg = `*${params.name}*, tu pago fue confirmado! ✅🎉\n\n`;
    msg += `Compraste *${discounted.length}* láminas:\n`;
    msg += discounted.join(", ") + "\n\n";
    msg += `Total pagado: *$${new Intl.NumberFormat("es-CO").format(order.totalAmount)} COP*\n\n`;

    if (outOfStock.length > 0) {
      msg += `⚠️ ${outOfStock.length} láminas ya no estaban disponibles: ${outOfStock.join(", ")}\n`;
    }

    msg +=
      "Te enviamos la confirmación a tu correo. Te contactaremos para la entrega. 📦";

    try {
      const chatResult = await sendUserChatMessage(order.user, msg);
      if (chatResult.delivered) {
        await updateUserStep(order.userId, "DONE");
        await markUserChatNotificationSent(order.id);
      } else if (chatResult.skipped && isBenignChatSkip(chatResult.reason)) {
        logTpagaWebhookInfo("user_chat_notification_skipped", {
          chargeToken: params.chargeToken,
          orderId: order.id,
          source: params.source,
          reason: chatResult.reason,
        });
        await markUserChatNotificationSent(order.id);
      } else {
        await markUserChatNotificationFailed(order.id, chatResult.reason);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markUserChatNotificationFailed(order.id, message);
      logTpagaWebhookError(
        "user_notification_failed",
        {
          chargeToken: params.chargeToken,
          orderId: order.id,
          source: params.source,
        },
        error
      );
    }
  }

  logTpagaWebhookInfo("payment_confirmed", {
    chargeToken: params.chargeToken,
    status: "settled",
    orderId: order.id,
    source: params.source,
  });

  return true;
}

async function handleRejectedPayment(params: {
  order: NonNullable<Awaited<ReturnType<typeof findOrderByTpagaToken>>>;
  chargeToken: string;
  name: string;
  normalizedStatus: string;
  rejectedReason: string | null;
  webhookEventId?: string;
  source: PaymentProcessSource;
}): Promise<boolean> {
  const rejected = await rejectOrderPayment(params.order.id, {
    tpagaStatus: params.normalizedStatus,
    webhookEventId: params.webhookEventId,
  });

  if (!rejected) {
    logTpagaWebhookInfo("order_already_settled", {
      chargeToken: params.chargeToken,
      orderId: params.order.id,
      source: params.source,
    });
    return true;
  }

  const notifyClaimed = await claimUserChatNotificationProcessing(
    params.order.id,
    "FAILED"
  );
  if (notifyClaimed) {
    let msg = `*${params.name}*, tu pago no se pudo completar 😔\n\n`;

    if (params.rejectedReason) {
      msg += `Razón: ${params.rejectedReason}\n\n`;
    }

    msg += "Puedes intentar de nuevo escribiendo *comprar*.";

    try {
      const chatResult = await sendUserChatMessage(params.order.user, msg);
      if (chatResult.delivered) {
        await updateUserStep(params.order.userId, "DONE");
        await markUserChatNotificationSent(params.order.id);
      } else if (chatResult.skipped && isBenignChatSkip(chatResult.reason)) {
        logTpagaWebhookInfo("user_chat_notification_skipped", {
          chargeToken: params.chargeToken,
          orderId: params.order.id,
          source: params.source,
          reason: chatResult.reason,
        });
        await markUserChatNotificationSent(params.order.id);
      } else {
        await markUserChatNotificationFailed(params.order.id, chatResult.reason);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markUserChatNotificationFailed(params.order.id, message);
      logTpagaWebhookError(
        "user_notification_failed",
        {
          chargeToken: params.chargeToken,
          orderId: params.order.id,
          source: params.source,
        },
        error
      );
    }
  }

  logTpagaWebhookInfo("payment_rejected", {
    chargeToken: params.chargeToken,
    orderId: params.order.id,
    source: params.source,
  });

  return true;
}

export function isSettledStatus(status: TpagaChargeStatus): boolean {
  return status === "settled";
}

