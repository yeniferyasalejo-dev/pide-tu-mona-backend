import axios from "axios";

function getApiUrl(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en .env");
  }
  return `https://api.telegram.org/bot${token}`;
}

export async function sendTelegramMessage(
  chatId: number | string,
  message: string
): Promise<void> {
  try {
    // Intentar con Markdown primero
    await axios.post(
      `${getApiUrl()}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      },
      { timeout: 10000 }
    );
    console.log(`[Telegram] Mensaje enviado a ${chatId}`);
  } catch (error: unknown) {
    // Si falla por Markdown, reintentar sin formato
    console.error(`[Telegram] Error con Markdown, reintentando sin formato...`);
    try {
      await axios.post(
        `${getApiUrl()}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
        },
        { timeout: 10000 }
      );
      console.log(`[Telegram] Mensaje enviado sin Markdown a ${chatId}`);
    } catch (retryError: unknown) {
      if (axios.isAxiosError(retryError)) {
        console.error(
          `[Telegram] Error definitivo enviando a ${chatId}:`,
          retryError.response?.data || retryError.message
        );
      } else {
        console.error(`[Telegram] Error definitivo enviando a ${chatId}:`, retryError);
      }
    }
  }
}

export async function setWebhook(url: string): Promise<void> {
  try {
    const res = await axios.post(`${getApiUrl()}/setWebhook`, {
      url: `${url}/webhook`,
      allowed_updates: ["message"],
    });
    console.log("[Telegram] Webhook configurado:", res.data);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("[Telegram] Error configurando webhook:", error.response?.data || error.message);
    } else {
      console.error("[Telegram] Error configurando webhook:", error);
    }
  }
}

export async function deleteWebhook(): Promise<void> {
  try {
    const res = await axios.post(`${getApiUrl()}/deleteWebhook`);
    console.log("[Telegram] Webhook eliminado:", res.data);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("[Telegram] Error eliminando webhook:", error.response?.data || error.message);
    } else {
      console.error("[Telegram] Error eliminando webhook:", error);
    }
  }
}
