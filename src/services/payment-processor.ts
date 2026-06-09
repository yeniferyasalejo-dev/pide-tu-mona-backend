import { STICKER_PRICE } from "../utils/validators";
import { getChargeStatus } from "./tpaga";
import {
  findOrderByTpagaToken,
  markOrderPaid,
  markOrderFailed,
  discountInventory,
  updateUserStep,
} from "./users";
import { sendPurchaseConfirmation } from "./email";
import { sendTelegramMessage } from "./telegram";
import { sendWhatsAppMessage } from "./whatsapp";

async function sendMessageToUser(
  user: { telegramChatId?: string | null; whatsappPhone?: string | null; channel?: string },
  message: string
) {
  if (user.channel === "whatsapp" && user.whatsappPhone) {
    await sendWhatsAppMessage(user.whatsappPhone, message);
  } else if (user.telegramChatId) {
    await sendTelegramMessage(user.telegramChatId, message);
  }
}

/**
 * Procesa un cobro que alcanzó estado final.
 * Usado tanto por el webhook como por el polling.
 * Retorna true si el cobro fue procesado (aprobado o rechazado).
 */
export async function processChargeResult(chargeToken: string): Promise<boolean> {
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

  if (chargeStatus.status === "settled" || chargeStatus.status === "authorized") {
    await markOrderPaid(order.id);

    const { discounted, outOfStock } = await discountInventory(stickerCodes);

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

    msg += `Te enviamos la confirmación a tu correo. Te contactaremos para la entrega. 📦`;

    await sendMessageToUser(order.user, msg);
    await updateUserStep(order.userId, "DONE");
    return true;

  } else if (
    chargeStatus.status === "charge-rejected" ||
    chargeStatus.status === "rejected" ||
    chargeStatus.status === "failed"
  ) {
    await markOrderFailed(order.id);

    let msg = `*${name}*, tu pago no se pudo completar 😔\n\n`;
    if (chargeStatus.rejectedReason) {
      msg += `Razón: ${chargeStatus.rejectedReason}\n\n`;
    }
    msg += `Puedes intentar de nuevo escribiendo *comprar*.`;

    await sendMessageToUser(order.user, msg);
    await updateUserStep(order.userId, "DONE");
    return true;
  }

  return false;
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
