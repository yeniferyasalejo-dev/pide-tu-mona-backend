import { Router, Request, Response } from "express";
import { processChargeResult, stopChargePolling } from "../services/payment-processor";

const router = Router();

/**
 * Webhook de Tpaga — se llama cuando un cobro alcanza estado final
 */
router.post("/tpaga/webhook", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const chargeToken = req.body?.charge_token;
    if (!chargeToken) {
      console.error("[Tpaga Webhook] No charge_token en el body");
      return;
    }

    console.log(`[Tpaga Webhook] Recibido para token: ${chargeToken}`);

    stopChargePolling(chargeToken);
    await processChargeResult(chargeToken);
  } catch (error) {
    console.error("[Tpaga Webhook] Error:", error);
  }
});

/**
 * Pagina de retorno despues de pagar en PSE
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
        <p>Te notificaremos por WhatsApp cuando se confirme.</p>
        <p>Tambien recibiras un correo de confirmacion con el detalle de tu compra y los pasos a seguir para la entrega. 📧</p>
        <p>Puedes cerrar esta pagina.</p>
        <p style="margin-top:20px;">
          <a href="https://wa.me/573011248084" style="color:#1a7a2e;font-weight:bold;">Volver a WhatsApp</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

export default router;
