import { sendTelegramMessage } from "./telegram";
import { sendWhatsAppMessage } from "./whatsapp";

export type UserChatSendResult =
  | { delivered: true; channel: "whatsapp" | "telegram" }
  | { delivered: false; skipped: true; reason: string };

/**
 * Envía un mensaje al canal del usuario (WhatsApp o Telegram).
 * WhatsApp y Telegram son independientes: omitir Telegram no afecta WhatsApp.
 */
export async function sendUserChatMessage(
  user: {
    telegramChatId?: string | null;
    whatsappPhone?: string | null;
    channel?: string;
  },
  message: string
): Promise<UserChatSendResult> {
  if (user.channel === "whatsapp" && user.whatsappPhone) {
    await sendWhatsAppMessage(user.whatsappPhone, message);
    return { delivered: true, channel: "whatsapp" };
  }

  if (user.telegramChatId) {
    const result = await sendTelegramMessage(user.telegramChatId, message);
    if ("skipped" in result) {
      return { delivered: false, skipped: true, reason: result.reason };
    }
    return { delivered: true, channel: "telegram" };
  }

  return { delivered: false, skipped: true, reason: "no_channel" };
}

/** Omisión controlada: no es un fallo de entrega ni debe marcar FAILED. */
export function isBenignChatSkip(reason: string): boolean {
  return reason === "disabled" || reason === "misconfigured" || reason === "no_channel";
}
