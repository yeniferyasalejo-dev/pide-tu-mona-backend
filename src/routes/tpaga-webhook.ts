import { Router, Request, Response } from "express";
import { getChargeStatus } from "../services/tpaga";
import {
  findOrderByTpagaToken,
  markOrderPaid,
  markOrderFailed,
  discountInventory,
  updateUserStep,
} from "../services/users";
import { sendPurchaseConfirmation } from "../services/email";
import { sendTelegramMessage } from "../services/telegram";

const router = Router();

/**
 * Webhook de Tpaga — se llama cuando un cobro alcanza estado final
 */
router.post("/tpaga/webhook", async (req: Request, res: Response) => {
  // Siempre responder 200 para que Tpaga no reintente
  res.sendStatus(200);

  try {
    const chargeToken = req.body?.charge_token;
    if (!chargeToken) {
      console.error("[Tpaga Webhook] No charge_token en el body");
      return;
    }

    console.log(`[Tpaga Webhook] Recibido para token: ${chargeToken}`);

    // Buscar la orden en nuestra base de datos
    const order = await findOrderByTpagaToken(chargeToken);
    if (!order) {
      console.error(`[Tpaga Webhook] Orden no encontrada para token: ${chargeToken}`);
      return;
    }

    // Verificar el estado directamente con Tpaga (nunca confiar solo en el webhook)
    const chargeStatus = await getChargeStatus(chargeToken);
    console.log(`[Tpaga Webhook] Estado del cobro: ${chargeStatus.status}`);

    const chatId = order.user.telegramChatId;
    const stickerCodes = order.items.map((item) => item.stickerCode);
    const name = order.user.name || "amigo";

    if (chargeStatus.status === "settled" || chargeStatus.status === "authorized") {
      // PAGO EXITOSO
      await markOrderPaid(order.id);

      // Descontar inventario
      const { discounted, outOfStock } = await discountInventory(stickerCodes);

      // Enviar email de confirmacion
      if (order.user.email) {
        await sendPurchaseConfirmation({
          to: order.user.email,
          buyerName: name,
          orderId: order.id,
          stickers: discounted,
          totalAmount: discounted.length * 5000,
        });
      }

      // Notificar por Telegram
      let msg = `*${name}*, tu pago fue confirmado! ✅🎉\n\n`;
      msg += `Compraste *${discounted.length}* laminas:\n`;
      msg += discounted.join(", ") + "\n\n";
      msg += `Total pagado: *$${new Intl.NumberFormat("es-CO").format(discounted.length * 5000)} COP*\n\n`;

      if (outOfStock.length > 0) {
        msg += `⚠️ ${outOfStock.length} laminas ya no estaban disponibles: ${outOfStock.join(", ")}\n`;
      }

      msg += `Te enviamos la confirmacion a tu correo. Te contactaremos para la entrega. 📦`;

      await sendTelegramMessage(chatId, msg);
      await updateUserStep(order.userId, "DONE");

    } else if (
      chargeStatus.status === "charge-rejected" ||
      chargeStatus.status === "rejected" ||
      chargeStatus.status === "failed"
    ) {
      // PAGO FALLIDO
      await markOrderFailed(order.id);

      let msg = `*${name}*, tu pago no se pudo completar 😔\n\n`;
      if (chargeStatus.rejectedReason) {
        msg += `Razon: ${chargeStatus.rejectedReason}\n\n`;
      }
      msg += `Puedes intentar de nuevo escribiendo *comprar*.`;

      await sendTelegramMessage(chatId, msg);
      await updateUserStep(order.userId, "DONE");
    }
  } catch (error) {
    console.error("[Tpaga Webhook] Error:", error);
  }
});

/**
 * Pagina de retorno despues de pagar en PSE
 * El usuario es redirigido aqui despues de completar/cancelar el pago en el banco
 */
router.get("/payment/status", (_req: Request, res: Response) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pide Tu Mona - Pago</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px 20px; background: #f5f5f5; }
        .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #1a7a2e; }
        p { color: #666; line-height: 1.6; }
        .emoji { font-size: 48px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="emoji">⚽</div>
        <h1>Pide Tu Mona</h1>
        <p><strong>Estamos procesando tu pago...</strong></p>
        <p>Te notificaremos por Telegram cuando se confirme.</p>
        <p>Tambien recibiras un correo de confirmacion con el detalle de tu compra y los pasos a seguir para la entrega. 📧</p>
        <p>Puedes cerrar esta pagina.</p>
        <p style="margin-top:20px;">
          <a href="https://t.me/mundial26_bot" style="color:#1a7a2e;font-weight:bold;">Volver al bot de Telegram</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

export default router;
