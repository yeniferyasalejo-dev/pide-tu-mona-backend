/**
 * Modo polling para desarrollo local (solo si Telegram está habilitado).
 * Uso: npm run dev:polling
 */

import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { findOrCreateUser } from "./services/users";
import { processMessage } from "./services/conversation";
import {
  canRunTelegramInfra,
  deleteWebhook,
  getTelegramBotToken,
  logTelegramStartupStatus,
  sendTelegramMessage,
} from "./services/telegram";

logTelegramStartupStatus();

if (!canRunTelegramInfra()) {
  console.log("[Polling] No se inicia: Telegram deshabilitado o mal configurado");
  process.exit(0);
}

let lastUpdateId = 0;

function getTelegramApiUrl(): string {
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN no configurado");
  }
  return `https://api.telegram.org/bot${token}`;
}

async function getUpdates(): Promise<void> {
  try {
    const res = await axios.get(`${getTelegramApiUrl()}/getUpdates`, {
      params: {
        offset: lastUpdateId + 1,
        timeout: 30,
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
      const reply = await processMessage(user, text);
      const result = await sendTelegramMessage(chatId, reply);
      if ("skipped" in result) {
        console.log(`[Polling] Respuesta no enviada por Telegram: ${result.reason}`);
      }
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") return;
    console.error("[Polling] Error:", error);
  }
}

async function start(): Promise<void> {
  console.log("[Polling] Eliminando webhook anterior...");
  await deleteWebhook();

  console.log("[Polling] Escríbele a @mundial26_bot en Telegram!");

  while (true) {
    await getUpdates();
  }
}

start().catch(console.error);
