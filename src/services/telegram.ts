import axios from "axios";
import {
  canRunTelegramInfra,
  canSendTelegramMessages,
  getTelegramBotToken,
  isTelegramEnabled,
  logTelegramNotificationSkipped,
  logTelegramStartupStatus,
  type TelegramMessageResult,
  validateTelegramConfig,
} from "./telegram-config";

function getApiUrl(): string {
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN no configurado");
  }
  return `https://api.telegram.org/bot${token}`;
}

export async function sendTelegramMessage(
  chatId: number | string,
  message: string
): Promise<TelegramMessageResult> {
  if (!isTelegramEnabled()) {
    logTelegramNotificationSkipped("disabled");
    return { skipped: true, reason: "disabled" };
  }

  if (!canSendTelegramMessages()) {
    console.error("[Telegram] telegram_notification_skipped", {
      reason: "misconfigured",
      detail: "Falta TELEGRAM_BOT_TOKEN con TELEGRAM_ENABLED=true",
    });
    return { skipped: true, reason: "misconfigured" };
  }

  try {
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
    return { sent: true };
  } catch (error: unknown) {
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
      return { sent: true };
    } catch (retryError: unknown) {
      if (axios.isAxiosError(retryError)) {
        console.error(
          `[Telegram] Error definitivo enviando a ${chatId}:`,
          retryError.response?.data || retryError.message
        );
      } else {
        console.error(`[Telegram] Error definitivo enviando a ${chatId}:`, retryError);
      }
      throw retryError;
    }
  }
}

export async function setWebhook(url: string): Promise<void> {
  if (!canRunTelegramInfra()) {
    logTelegramStartupStatus();
    return;
  }

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
  if (!canRunTelegramInfra()) {
    return;
  }

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

export {
  isTelegramEnabled,
  canRunTelegramInfra,
  canSendTelegramMessages,
  getTelegramBotToken,
  validateTelegramConfig,
  logTelegramStartupStatus,
};
