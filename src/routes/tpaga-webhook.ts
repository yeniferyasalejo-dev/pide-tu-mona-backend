import { Router, Request, Response } from "express";
import { processChargeResult, stopChargePolling } from "../services/payment-processor";
import { findOrderById } from "../services/users";

const router = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPaymentStatusPage(options: {
  title: string;
  heading: string;
  message: string;
  emoji: string;
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const emoji = escapeHtml(options.emoji);

  return `<!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
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
        <div class="emoji">${emoji}</div>
        <h1>${heading}</h1>
        <p>${message}</p>
        <p style="margin-top:20px;">
          <a href="https://wa.me/573011248084" style="color:#1a7a2e;font-weight:bold;">Volver a WhatsApp</a>
        </p>
      </div>
    </body>
    </html>`;
}

router.post("/tpaga/webhook", (req: Request, res: Response) => {
  const chargeToken = String(req.body?.charge_token ?? "").trim();

  console.log("[Tpaga Webhook] Notificación recibida", {
    contentType: req.headers["content-type"],
    chargeToken: chargeToken || null,
  });

  if (!chargeToken) {
    console.error("[Tpaga Webhook] No llegó charge_token");

    res.status(400).json({
      received: false,
      error: "charge_token is required",
    });
    return;
  }

  res.status(200).json({
    received: true,
  });

  void (async () => {
    try {
      const processed = await processChargeResult(chargeToken);

      if (processed) {
        stopChargePolling(chargeToken);
        console.log(
          `[Tpaga Webhook] Cobro ${chargeToken} procesado correctamente`
        );
      } else {
        console.log(
          `[Tpaga Webhook] Cobro ${chargeToken} aún no tiene estado final`
        );
      }
    } catch (error) {
      console.error(
        `[Tpaga Webhook] Error procesando ${chargeToken}:`,
        error
      );
    }
  })();
});

/**
 * Pagina de retorno despues de pagar en PSE
 */
router.get("/payment/status", async (req: Request, res: Response) => {
  const orderId = typeof req.query.orderId === "string" ? req.query.orderId.trim() : "";

  if (!orderId) {
    res.status(400).send(
      renderPaymentStatusPage({
        title: "Pide Tu Mona - Pago",
        heading: "Pide Tu Mona",
        message: "Falta el identificador de la orden. Vuelve al enlace de pago o contactanos por WhatsApp.",
        emoji: "⚠️",
      })
    );
    return;
  }

  let order = await findOrderById(orderId);

  if (!order) {
    res.status(404).send(
      renderPaymentStatusPage({
        title: "Pide Tu Mona - Pago",
        heading: "Pide Tu Mona",
        message: "No encontramos esta orden. Si ya pagaste, te avisaremos por WhatsApp en unos minutos.",
        emoji: "🔍",
      })
    );
    return;
  }

  const isFinalStatus = order.status === "PAID" || order.status === "FAILED";

  if (!isFinalStatus && order.tpagaChargeToken) {
    try {
      await processChargeResult(order.tpagaChargeToken);
      order = (await findOrderById(orderId)) ?? order;
    } catch (error) {
      console.error(
        `[Payment Status] Error consultando pago para orden ${orderId}:`,
        error
      );
    }
  }

  if (order.status === "PAID") {
    res.send(
      renderPaymentStatusPage({
        title: "Pide Tu Mona - Pago confirmado",
        heading: "Pago confirmado",
        message:
          "Tu pago fue confirmado. Te notificaremos por WhatsApp y recibiras un correo con el detalle de tu compra.",
        emoji: "✅",
      })
    );
    return;
  }

  if (order.status === "FAILED") {
    res.send(
      renderPaymentStatusPage({
        title: "Pide Tu Mona - Pago no completado",
        heading: "Pago no completado",
        message:
          "Tu pago no se pudo completar. Puedes intentar de nuevo escribiendo comprar en WhatsApp.",
        emoji: "❌",
      })
    );
    return;
  }

  res.send(
    renderPaymentStatusPage({
      title: "Pide Tu Mona - Pago",
      heading: "Pide Tu Mona",
      message:
        "Estamos procesando tu pago. Te notificaremos por WhatsApp cuando se confirme. Tambien recibiras un correo de confirmacion.",
      emoji: "⚽",
    })
  );
});

export default router;
