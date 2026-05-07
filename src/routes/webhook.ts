import { Router, Request, Response } from "express";
import { findOrCreateUser } from "../services/users";
import { processMessage } from "../services/conversation";
import { sendTelegramMessage } from "../services/telegram";

const router = Router();

// Telegram envía updates vía POST al webhook
router.post("/webhook", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = message.text;

    // Solo procesamos mensajes de texto
    if (!chatId || !text) return;

    console.log(`[Webhook] Mensaje de ${chatId}: "${text}"`);

    const user = await findOrCreateUser(String(chatId));
    console.log(`[Webhook] Usuario ${user.id} — estado: ${user.onboardingStep}`);

    const reply = await processMessage(user, text);
    console.log(`[Webhook] Respuesta para ${chatId}: "${reply.substring(0, 80)}..."`);

    await sendTelegramMessage(chatId, reply);
  } catch (error) {
    console.error("[Webhook] Error procesando mensaje:", error);
  }
});

export default router;
