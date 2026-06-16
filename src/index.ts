import dotenv from "dotenv";
dotenv.config();

import express from "express";
import adminRouter from "./routes/admin";
import tpagaWebhookRouter from "./routes/tpaga-webhook";
import whatsappWebhookRouter from "./routes/whatsapp-webhook";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rutas
app.use(adminRouter);
app.use(tpagaWebhookRouter);
app.use(whatsappWebhookRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", channel: "whatsapp", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[Server] Pide Tu Mona corriendo en puerto ${PORT}`);
});

export default app;
