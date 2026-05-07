/**
 * Script de producción: corre el servidor Express + polling de Telegram
 * en un solo proceso. Ideal para Railway/hosting.
 */

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import webhookRouter from "./routes/webhook";
import adminRouter from "./routes/admin";
import { findOrCreateUser } from "./services/users";
import { processMessage } from "./services/conversation";
import { sendTelegramMessage, deleteWebhook } from "./services/telegram";

// === Express Server (health check + admin) ===
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(webhookRouter);
app.use(adminRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "polling", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[Server] Pide Tu Mona corriendo en puerto ${PORT}`);
});

// === Telegram Polling ===
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;

async function getUpdates(): Promise<void> {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 30 },
      timeout: 35000,
    });

    const updates = res.data?.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const message = update.message;
      if (!message?.text || !message?.chat?.id) continue;

      const chatId = message.chat.id;
      const text = message.text;

      console.log(`[Bot] Mensaje de ${chatId}: "${text}"`);

      try {
        const user = await findOrCreateUser(String(chatId));
        const reply = await processMessage(user, text);
        await sendTelegramMessage(chatId, reply);
      } catch (error) {
        console.error(`[Bot] Error procesando mensaje de ${chatId}:`, error);
      }
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") return;
    console.error("[Bot] Error en polling:", error);
    // Esperar 5 segundos antes de reintentar si hay error
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function startPolling(): Promise<void> {
  console.log("[Bot] Eliminando webhook anterior...");
  await deleteWebhook();
  console.log("[Bot] Polling iniciado. Esperando mensajes de @mundial26_bot...");

  while (true) {
    await getUpdates();
  }
}

startPolling().catch(console.error);
