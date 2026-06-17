/**
 * Script de producción: corre el servidor Express y, opcionalmente, polling de Telegram.
 */

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import webhookRouter from "./routes/webhook";
import adminRouter from "./routes/admin";
import tpagaWebhookRouter from "./routes/tpaga-webhook";
import whatsappWebhookRouter from "./routes/whatsapp-webhook";
import { startReconciliationWorker } from "./services/tpaga-reconciliation";
import { findOrCreateUser } from "./services/users";
import { processMessage } from "./services/conversation";
import {
  canRunTelegramInfra,
  deleteWebhook,
  getTelegramBotToken,
  logTelegramStartupStatus,
  sendTelegramMessage,
} from "./services/telegram";

const userLocks = new Map<string, Promise<void>>();

async function processWithLock(chatId: string, text: string): Promise<void> {
  const key = chatId;
  const prev = userLocks.get(key) || Promise.resolve();

  const current = prev.then(async () => {
    try {
      await Promise.race([
        (async () => {
          const user = await findOrCreateUser(chatId);
          console.log(`[Bot] Usuario ${user.id} — estado: ${user.onboardingStep}`);
          const reply = await processMessage(user, text);
          const result = await sendTelegramMessage(chatId, reply);
          if ("skipped" in result) {
            console.log(`[Bot] Respuesta no enviada por Telegram: ${result.reason}`);
          }
        })(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout global 15s")), 15000)
        ),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Bot] Error procesando mensaje de ${chatId}: ${msg}`);
      if (msg.includes("Timeout")) {
        try {
          const result = await sendTelegramMessage(
            chatId,
            "Tardé mucho en procesar tu mensaje. Prueba de nuevo o escribe las láminas así: COL12, MEX6"
          );
          if ("skipped" in result) {
            console.log(`[Bot] Fallback no enviado por Telegram: ${result.reason}`);
          }
        } catch {
          /* ignorar */
        }
      }
    }
  });

  userLocks.set(key, current);
  await current;

  if (userLocks.get(key) === current) {
    userLocks.delete(key);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(webhookRouter);
app.use(adminRouter);
app.use(tpagaWebhookRouter);
app.use(whatsappWebhookRouter);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: canRunTelegramInfra() ? "polling" : "server-only",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Pide Tu Mona corriendo en puerto ${PORT}`);
  logTelegramStartupStatus();
  startReconciliationWorker();
});

let lastUpdateId = 0;
const processedMessages = new Map<string, Set<number>>();
const MAX_PROCESSED_PER_CHAT = 50;

function isAlreadyProcessed(chatId: string, messageId: number): boolean {
  const processed = processedMessages.get(chatId);
  if (!processed) {
    processedMessages.set(chatId, new Set([messageId]));
    return false;
  }
  if (processed.has(messageId)) return true;
  processed.add(messageId);
  if (processed.size > MAX_PROCESSED_PER_CHAT) {
    const arr = [...processed];
    processedMessages.set(chatId, new Set(arr.slice(-MAX_PROCESSED_PER_CHAT)));
  }
  return false;
}

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
      params: { offset: lastUpdateId + 1, timeout: 30 },
      timeout: 35000,
    });

    const updates = res.data?.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const message = update.message;
      if (!message?.text || !message?.chat?.id) continue;

      const chatId = message.chat.id;
      const messageId = message.message_id;
      const text = message.text;

      if (isAlreadyProcessed(String(chatId), messageId)) {
        console.log(`[Bot] Mensaje duplicado ignorado: ${chatId}/${messageId}`);
        continue;
      }

      console.log(`[Bot] Mensaje de ${chatId}: "${text}"`);
      await processWithLock(String(chatId), text);
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") return;
    console.error("[Bot] Error en polling:", error);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function flushPendingUpdates(): Promise<void> {
  try {
    const res = await axios.get(`${getTelegramApiUrl()}/getUpdates`, {
      params: { offset: -1, timeout: 0 },
      timeout: 5000,
    });
    const updates = res.data?.result || [];
    if (updates.length > 0) {
      lastUpdateId = updates[updates.length - 1].update_id;
      console.log(`[Bot] Descartados ${updates.length} mensajes pendientes (último ID: ${lastUpdateId})`);
    }
  } catch (error) {
    console.error("[Bot] Error descartando mensajes pendientes:", error);
  }
}

async function startPolling(): Promise<void> {
  console.log("[Bot] Eliminando webhook anterior...");
  await deleteWebhook();
  await flushPendingUpdates();

  console.log("[Bot] Esperando 3s para evitar conflictos...");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("[Bot] Polling iniciado. Esperando mensajes de @mundial26_bot...");

  while (true) {
    await getUpdates();
  }
}

if (canRunTelegramInfra()) {
  startPolling().catch(console.error);
} else {
  console.log("[Bot] Polling de Telegram no iniciado");
}
