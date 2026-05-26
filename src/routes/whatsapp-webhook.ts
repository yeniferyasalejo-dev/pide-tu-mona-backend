import { Router, Request, Response } from "express";
import { findOrCreateUser } from "../services/users";
import { processMessage } from "../services/conversation";
import { sendWhatsAppMessage } from "../services/whatsapp";

const router = Router();

// Lock por usuario para evitar race conditions
const userLocks = new Map<string, Promise<void>>();

async function processWithLock(phone: string, text: string): Promise<void> {
  const prev = userLocks.get(phone) || Promise.resolve();

  const current = prev.then(async () => {
    try {
      await Promise.race([
        (async () => {
          const user = await findOrCreateUser(phone, "whatsapp");
          console.log(`[WA Webhook] Usuario ${user.id} — estado: ${user.onboardingStep}`);
          const reply = await processMessage(user, text);
          await sendWhatsAppMessage(phone, reply);
        })(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout 15s")), 15000)
        ),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[WA Webhook] Error procesando ${phone}: ${msg}`);
      if (msg.includes("Timeout")) {
        try {
          await sendWhatsAppMessage(phone,
            "Tardé mucho en procesar tu mensaje. Prueba de nuevo o escribe las láminas así: COL12, MEX6"
          );
        } catch { /* ignorar */ }
      }
    }
  });

  userLocks.set(phone, current);
  await current;
  if (userLocks.get(phone) === current) userLocks.delete(phone);
}

/**
 * Webhook de Infobip — recibe mensajes entrantes de WhatsApp
 * Configura esta URL en Infobip portal: https://tu-app.railway.app/webhook/whatsapp
 */
router.post("/webhook/whatsapp", async (req: Request, res: Response) => {
  // Siempre responder 200 rápido
  res.sendStatus(200);

  try {
    // Log completo del body para debug
    console.log(`[WA Webhook] Body recibido: ${JSON.stringify(req.body).substring(0, 500)}`);

    // Formato 1: Subscriptions/standard {"results": [...]}
    // Formato 2: MO_OTT_CONTACT keyword forwarding (puede ser diferente)
    let results = req.body?.results;

    // Si no tiene "results", intentar interpretar el body directamente
    if (!results || !Array.isArray(results)) {
      // Puede ser un solo mensaje o formato keyword forwarding
      if (req.body?.from && (req.body?.message || req.body?.text || req.body?.cleanText)) {
        results = [req.body];
      } else if (req.body?.messages && Array.isArray(req.body.messages)) {
        results = req.body.messages;
      } else {
        console.log("[WA Webhook] Formato no reconocido, ignorando");
        return;
      }
    }

    for (const msg of results) {
      const from = msg.from || msg.sender; // Número del usuario
      const message = msg.message;

      if (!from) continue;

      let text = "";

      // Si tiene campo "message" con tipo (formato subscriptions/standard)
      if (message && message.type) {
        switch (message.type) {
          case "TEXT":
            text = message.text || "";
            break;
          case "INTERACTIVE_BUTTON_REPLY":
            text = message.id || message.title || "";
            break;
          case "INTERACTIVE_LIST_REPLY":
            text = message.id || message.title || "";
            break;
          default:
            console.log(`[WA Webhook] Tipo no soportado: ${message.type} de ${from}`);
            await sendWhatsAppMessage(from,
              "Por ahora solo puedo leer mensajes de texto. Escríbeme las láminas que necesitas. 😊"
            );
            continue;
        }
      } else {
        // Formato keyword forwarding: puede tener text, cleanText, message como string
        text = msg.cleanText || msg.text || msg.keyword || (typeof message === "string" ? message : "") || "";
      }

      if (!text.trim()) continue;

      console.log(`[WA Webhook] Mensaje de ${from}: "${text}"`);

      // Procesar con lock anti-race-condition
      processWithLock(from, text).catch(console.error);
    }
  } catch (error) {
    console.error("[WA Webhook] Error:", error);
  }
});

export default router;
