import dotenv from "dotenv";
dotenv.config();

import express from "express";
import webhookRouter from "./routes/webhook";
import adminRouter from "./routes/admin";
import tpagaWebhookRouter from "./routes/tpaga-webhook";
import whatsappWebhookRouter from "./routes/whatsapp-webhook";
import { canRunTelegramInfra, logTelegramStartupStatus, setWebhook } from "./services/telegram";
import { startReconciliationWorker } from "./services/tpaga-reconciliation";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rutas
app.use(webhookRouter);
app.use(adminRouter);
app.use(tpagaWebhookRouter);
app.use(whatsappWebhookRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Configurar webhook de Telegram (llamar una vez con la URL pública)
app.get("/setup-webhook", async (req, res) => {
  if (!canRunTelegramInfra()) {
    logTelegramStartupStatus();
    res.status(503).json({
      error: "Telegram deshabilitado o mal configurado",
      hint: "Define TELEGRAM_ENABLED=true con TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID",
    });
    return;
  }

  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: "Falta el parámetro ?url=https://tu-dominio.com" });
    return;
  }
  await setWebhook(url);
  res.json({ ok: true, message: `Webhook configurado en ${url}/webhook` });
});

app.listen(PORT, () => {
  console.log(`[Server] Pide Tu Mona corriendo en puerto ${PORT}`);
  logTelegramStartupStatus();
  startReconciliationWorker();
});

export default app;
