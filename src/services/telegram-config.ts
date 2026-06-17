export type TelegramSkipReason = "disabled" | "misconfigured";

export type TelegramMessageResult =
  | { skipped: true; reason: TelegramSkipReason }
  | { sent: true };

/** Por defecto Telegram está deshabilitado si la variable no existe. */
export function isTelegramEnabled(): boolean {
  return process.env.TELEGRAM_ENABLED === "true";
}

export function validateTelegramConfig(): { ok: true } | { ok: false; errors: string[] } {
  if (!isTelegramEnabled()) {
    return { ok: false, errors: ["disabled"] };
  }

  const errors: string[] = [];
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token) {
    errors.push("TELEGRAM_BOT_TOKEN es requerido cuando TELEGRAM_ENABLED=true");
  }
  if (!chatId) {
    errors.push("TELEGRAM_CHAT_ID es requerido cuando TELEGRAM_ENABLED=true");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };
}

/** Token válido para enviar mensajes a chat IDs de usuarios (no requiere TELEGRAM_CHAT_ID). */
export function getTelegramBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token || null;
}

export function canSendTelegramMessages(): boolean {
  return isTelegramEnabled() && getTelegramBotToken() != null;
}

/** Infraestructura del bot (polling, webhook): requiere token y chat ID de entorno. */
export function canRunTelegramInfra(): boolean {
  return validateTelegramConfig().ok;
}

export function logTelegramNotificationSkipped(reason: TelegramSkipReason): void {
  console.log("[Telegram] telegram_notification_skipped", { reason });
}

export function logTelegramStartupStatus(): void {
  if (!isTelegramEnabled()) {
    console.log("[Telegram] Deshabilitado (TELEGRAM_ENABLED no es true)");
    return;
  }

  const validation = validateTelegramConfig();
  if (!validation.ok) {
    console.error(
      "[Telegram] Configuración inválida; solo Telegram queda inactivo:",
      validation.errors.filter((e) => e !== "disabled").join("; ")
    );
  }
}
