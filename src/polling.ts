/**
 * Modo polling para desarrollo local.
 * En vez de esperar que Telegram mande mensajes a un webhook,
 * este script le pregunta a Telegram "¿hay mensajes nuevos?" cada 2 segundos.
 * Así no necesitas ngrok ni URL pública para probar.
 *
 * Uso: npm run dev:polling
 */

import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { findOrCreateUser } from "./services/users";
import { processMessage } from "./services/conversation";
import { sendTelegramMessage, deleteWebhook } from "./services/telegram";

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;

async function getUpdates(): Promise<void> {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: {
        offset: lastUpdateId + 1,
        timeout: 30, // Long polling — espera hasta 30s por mensajes nuevos
      },
      timeout: 35000,
    });

    const updates = res.data?.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;

      const message = update.message;
      if (!message?.text || !message?.chat?.id) continue;

      const chatId = message.chat.id;
      const text = message.text;

      console.log(`[Polling] Mensaje de ${chatId}: "${text}"`);

      const user = await findOrCreateUser(String(chatId));
      console.log(`[Polling] Usuario ${user.id} — estado: ${user.onboardingStep}`);

      const reply = await processMessage(user, text);
      console.log(`[Polling] Respuesta: "${reply.substring(0, 80)}..."`);

      await sendTelegramMessage(chatId, reply);
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") {
      // Timeout normal del long polling, no es error
      return;
    }
    console.error("[Polling] Error:", error);
  }
}

async function main(): Promise<void> {
  console.log("[Polling] Eliminando webhook anterior (si existe)...");
  await deleteWebhook();

  console.log("[Polling] Bot iniciado en modo polling. Esperando mensajes...");
  console.log("[Polling] Escríbele a @mundial26_bot en Telegram!");

  while (true) {
    await getUpdates();
  }
}

main().catch(console.error);
