import { getChargeStatus } from "./tpaga";
import {
  findOrderByTpagaToken,
  markOrderFailed,
  settleOrderPayment,
  updateUserStep,
  OrderAlreadySettledError,
} from "./users";
import { sendPurchaseConfirmation } from "./email";
import { sendWhatsAppMessage } from "./whatsapp";

async function sendMessageToUser(
  user: { whatsappPhone?: string | null },
  message: string
) {
  if (user.whatsappPhone) {
    await sendWhatsAppMessage(user.whatsappPhone, message);
  }
}

/**
 * Procesa un cobro que alcanzó estado final.
 * Usado tanto por el webhook como por el polling.
 * Retorna true si el cobro fue procesado (aprobado o rechazado).
 */
const activeProcessing = new Set<string>();

export async function processChargeResult(chargeToken: string): Promise<boolean> {
  if (activeProcessing.has(chargeToken)) {
    console.log(`[Payment] Cobro ${chargeToken} ya se está procesando`);
    return false;
  }

  activeProcessing.add(chargeToken);
  try {
    const order = await findOrderByTpagaToken(chargeToken);
    if (!order) {
      console.error(`[Payment] Orden no encontrada para token: ${chargeToken}`);
      return false;
    }

    if (order.status === "PAID" || order.status === "FAILED") {
      return true;
    }

    const chargeStatus = await getChargeStatus(chargeToken);
    console.log(`[Payment] Estado del cobro ${chargeToken}: ${chargeStatus.status}`);

    const stickerCodes = order.items.map((item) => item.stickerCode);
    const name = order.user.name || "amigo";

    if (chargeStatus.status === "settled") {
      const freshOrder = await findOrderByTpagaToken(chargeToken);
      if (!freshOrder || freshOrder.status === "PAID" || freshOrder.status === "FAILED") {
        return true;
      }

      let discounted: string[] = [];
      let outOfStock: string[] = [];

      try {
        const settlement = await settleOrderPayment(
          order.id,
          order.userId,
          stickerCodes
        );

        if (!settlement.settled) {
          console.log(
            `[Payment] Orden ${order.id} ya fue procesada por otro proceso`
          );
          return true;
        }

        discounted = settlement.discounted;
        outOfStock = settlement.outOfStock;
      } catch (error) {
        if (error instanceof OrderAlreadySettledError) {
          console.log(`[Payment] ${error.message}`);
          return true;
        }

        console.error(
          `[Payment] Error confirmando orden ${order.id} atómicamente:`,
          error
        );
        return false;
      }

      if (order.user.email) {
        await sendPurchaseConfirmation({
          to: order.user.email,
          buyerName: name,
          orderId: order.id,
          stickers: discounted,
          totalAmount: order.totalAmount,
          deliveryAddress: order.deliveryAddress || undefined,
        });
      }

      let msg = `*${name}*, tu pago fue confirmado! ✅🎉\n\n`;
      msg += `Compraste *${discounted.length}* láminas:\n`;
      msg += discounted.join(", ") + "\n\n";
      msg += `Total pagado: *$${new Intl.NumberFormat("es-CO").format(order.totalAmount)} COP*\n\n`;

      if (outOfStock.length > 0) {
        msg += `⚠️ ${outOfStock.length} láminas ya no estaban disponibles: ${outOfStock.join(", ")}\n`;
      }

      msg +=
        "Te enviamos la confirmación a tu correo. Te contactaremos para la entrega. 📦";

      await sendMessageToUser(order.user, msg);
      await updateUserStep(order.userId, "DONE");

      return true;
    } else if (
      chargeStatus.status === "authorized" ||
      chargeStatus.status === "pending"
    ) {
      console.log(
        `[Payment] Cobro ${chargeToken} todavía está en ${chargeStatus.status}`
      );

      return false;
    } else if (
      chargeStatus.status === "charge-rejected" ||
      chargeStatus.status === "rejected" ||
      chargeStatus.status === "failed"
    ) {
      const markedFailed = await markOrderFailed(order.id);
      if (!markedFailed) {
        console.log(
          `[Payment] Orden ${order.id} ya fue procesada por otro proceso`
        );
        return true;
      }

      let msg = `*${name}*, tu pago no se pudo completar 😔\n\n`;

      if (chargeStatus.rejectedReason) {
        msg += `Razón: ${chargeStatus.rejectedReason}\n\n`;
      }

      msg += "Puedes intentar de nuevo escribiendo *comprar*.";

      await sendMessageToUser(order.user, msg);
      await updateUserStep(order.userId, "DONE");

      return true;
    }

    return false;
  } finally {
    activeProcessing.delete(chargeToken);
  }
}

// ==================== POLLING ====================

const activePollers = new Map<string, NodeJS.Timeout>();
const POLL_INTERVAL = 30_000; // 30 segundos
const MAX_POLL_TIME = 30 * 60_000; // 30 minutos

/**
 * Inicia polling para verificar el estado de un cobro.
 * Consulta Tpaga cada 30s hasta que el cobro sea aprobado/rechazado o pasen 30 min.
 */
export function startChargePolling(chargeToken: string): void {
  if (activePollers.has(chargeToken)) return;

  const startedAt = Date.now();
  console.log(`[Polling] Iniciando para ${chargeToken}`);

  const interval = setInterval(async () => {
    try {
      if (Date.now() - startedAt > MAX_POLL_TIME) {
        console.log(`[Polling] Timeout para ${chargeToken} (30 min)`);
        stopChargePolling(chargeToken);
        return;
      }

      const processed = await processChargeResult(chargeToken);
      if (processed) {
        console.log(`[Polling] Cobro ${chargeToken} procesado, deteniendo polling`);
        stopChargePolling(chargeToken);
      }
    } catch (error) {
      console.error(`[Polling] Error verificando ${chargeToken}:`, error);
    }
  }, POLL_INTERVAL);

  activePollers.set(chargeToken, interval);
}

export function stopChargePolling(chargeToken: string): void {
  const interval = activePollers.get(chargeToken);
  if (interval) {
    clearInterval(interval);
    activePollers.delete(chargeToken);
    console.log(`[Polling] Detenido para ${chargeToken}`);
  }
}
