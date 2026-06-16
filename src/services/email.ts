import nodemailer from "nodemailer";
import { STICKER_PRICE_FORMATTED } from "../utils/validators";

const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD || "";
const SELLER_EMAIL = process.env.SELLER_EMAIL || "vendsysselweb@gmail.com";

function getTransporter() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) {
    console.log("[Email] No configurado (falta EMAIL_USER o EMAIL_APP_PASSWORD)");
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Envía email de confirmación de compra
 */
export async function sendPurchaseConfirmation(params: {
  to: string;
  buyerName: string;
  orderId: string;
  stickers: string[];
  totalAmount: number;
  deliveryAddress?: string;
}): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    console.log("[Email] No se puede enviar — email no configurado");
    return false;
  }

  const stickerRows = params.stickers
    .map(
      (code) =>
        `<tr><td style="padding:8px;border:1px solid #ddd;">${code}</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">$${STICKER_PRICE_FORMATTED}</td></tr>`
    )
    .join("");

  const totalFormatted = new Intl.NumberFormat("es-CO").format(params.totalAmount);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a7a2e;color:white;padding:20px;text-align:center;">
        <h1 style="margin:0;">Pide Tu Mona</h1>
        <p style="margin:5px 0 0;">Album Mundial 2026</p>
      </div>

      <div style="padding:20px;">
        <h2>Confirmacion de Compra</h2>
        <p>Hola <strong>${params.buyerName}</strong>,</p>
        <p>Tu pago ha sido confirmado. Aqui tienes el detalle de tu compra:</p>

        <p><strong>Orden:</strong> #${params.orderId.substring(0, 8)}</p>

        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px;border:1px solid #ddd;text-align:left;">Lamina</th>
              <th style="padding:8px;border:1px solid #ddd;text-align:right;">Precio</th>
            </tr>
          </thead>
          <tbody>
            ${stickerRows}
          </tbody>
          <tfoot>
            <tr style="background:#f5f5f5;font-weight:bold;">
              <td style="padding:8px;border:1px solid #ddd;">TOTAL (${params.stickers.length} laminas)</td>
              <td style="padding:8px;border:1px solid #ddd;text-align:right;">$${totalFormatted} COP</td>
            </tr>
          </tfoot>
        </table>

        ${params.deliveryAddress ? `
        <div style="background:#f0f8f0;padding:15px;border-radius:8px;margin:15px 0;">
          <h3 style="margin:0 0 10px;color:#1a7a2e;">📦 Direccion de entrega:</h3>
          <p style="margin:0;white-space:pre-line;">${params.deliveryAddress}</p>
        </div>
        ` : ''}

        <p>Te contactaremos pronto para coordinar la entrega de tus laminas.</p>

        <p style="color:#666;font-size:12px;margin-top:30px;">
          Este es un correo automatico de Pide Tu Mona. Si tienes dudas, escribenos por WhatsApp: wa.me/573011248084.
        </p>
      </div>
    </div>
  `;

  try {
    // Email al cliente
    await transporter.sendMail({
      from: `"Pide Tu Mona" <${EMAIL_USER}>`,
      to: params.to,
      subject: `Confirmacion de compra #${params.orderId.substring(0, 8)} - Pide Tu Mona`,
      html,
    });
    console.log(`[Email] Confirmacion enviada a ${params.to}`);

    // Notificación a la vendedora
    try {
      await sendSellerNotification(params);
    } catch (e) {
      console.error("[Email] Error enviando notificación a vendedora:", e);
    }

    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Email] Error enviando:", msg);
    return false;
  }
}

/**
 * Notifica a la vendedora de una nueva venta
 */
async function sendSellerNotification(params: {
  to: string;
  buyerName: string;
  orderId: string;
  stickers: string[];
  totalAmount: number;
  deliveryAddress?: string;
}): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) return;

  const totalFormatted = new Intl.NumberFormat("es-CO").format(params.totalAmount);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#ff9800;color:white;padding:20px;text-align:center;">
        <h1 style="margin:0;">Nueva Venta! 🎉</h1>
      </div>
      <div style="padding:20px;">
        <p><strong>Comprador:</strong> ${params.buyerName}</p>
        <p><strong>Email:</strong> ${params.to}</p>
        <p><strong>Orden:</strong> #${params.orderId.substring(0, 8)}</p>
        <p><strong>Laminas (${params.stickers.length}):</strong> ${params.stickers.join(", ")}</p>
        <p><strong>Total:</strong> $${totalFormatted} COP</p>
        ${params.deliveryAddress ? `
        <div style="background:#fff3e0;padding:15px;border-radius:8px;margin:15px 0;">
          <p style="margin:0;"><strong>📦 Direccion de entrega:</strong></p>
          <p style="margin:5px 0 0;white-space:pre-line;">${params.deliveryAddress}</p>
        </div>
        ` : ''}
        <hr style="margin:20px 0;">
        <p style="color:#666;">Coordina la entrega con el cliente.</p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"Pide Tu Mona" <${EMAIL_USER}>`,
    to: SELLER_EMAIL,
    subject: `💰 Nueva venta #${params.orderId.substring(0, 8)} - ${params.buyerName} - $${totalFormatted}`,
    html,
  });
  console.log(`[Email] Notificacion de venta enviada a ${SELLER_EMAIL}`);
}
