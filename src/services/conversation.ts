import { User } from "@prisma/client";
import {
  updateUserName,
  updateUserEmail,
  saveStickers,
  resetToWaitingStickers,
  checkInventory,
} from "./users";
import { isValidEmail, parseStickerNumbers } from "../utils/validators";

const HELP_MESSAGE = `📋 *Comandos disponibles:*

• *actualizar* — Envía tu lista de láminas de nuevo
• *ayuda* o */ayuda* — Muestra este menú

Si tienes dudas, escribe *ayuda* en cualquier momento.`;

export async function processMessage(
  user: User,
  text: string
): Promise<string> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Comandos globales (funcionan desde cualquier estado)
  if (lower === "ayuda" || lower === "/ayuda" || lower === "/help") {
    return HELP_MESSAGE;
  }

  // Comando /start de Telegram — reinicia si ya existe, o saluda si es nuevo
  if (lower === "/start" && user.onboardingStep !== "START") {
    await updateStep(user.id, "START");
    return handleStart(user, trimmed);
  }

  // Comando "actualizar" solo si ya completó el onboarding
  if ((lower === "actualizar" || lower === "/actualizar") && user.onboardingStep === "DONE") {
    await resetToWaitingStickers(user.id);
    return "Mándame tu nueva lista de láminas separadas por coma. Ejemplo: 12, 45, 78, 102";
  }

  switch (user.onboardingStep) {
    case "START":
      return handleStart(user, trimmed);
    case "WAITING_NAME":
      return handleName(user, trimmed);
    case "WAITING_EMAIL":
      return handleEmail(user, trimmed);
    case "WAITING_STICKERS":
      return handleStickers(user, trimmed);
    case "DONE":
      return handleDone(user);
    default:
      return "Algo salió mal. Escribe *ayuda* para ver los comandos disponibles.";
  }
}

async function handleStart(_user: User, _text: string): Promise<string> {
  // Primer mensaje: el webhook ya creó el usuario con START,
  // lo pasamos a WAITING_NAME
  await updateStep(_user.id, "WAITING_NAME");
  return (
    "¡Hola! 👋 Bienvenido a *Pide Tu Mona*, la plataforma para intercambiar " +
    "monas del álbum del Mundial 2026.\n\nPara empezar, ¿cómo te llamas?"
  );
}

async function handleName(user: User, text: string): Promise<string> {
  if (text.length < 2 || text.length > 100) {
    return "Por favor, mándame un nombre válido (entre 2 y 100 caracteres).";
  }
  await updateUserName(user.id, text);
  return `Genial, *${text}*. ¿Cuál es tu correo electrónico?`;
}

async function handleEmail(user: User, text: string): Promise<string> {
  if (!isValidEmail(text)) {
    return "Ese correo no parece válido. Por favor mándame un email correcto, por ejemplo: juan@gmail.com";
  }
  await updateUserEmail(user.id, text.trim().toLowerCase());
  return "Perfecto. Ahora mándame las láminas que te faltan, separadas por coma.\n\nEjemplo: 12, 45, 78, 102";
}

async function handleStickers(user: User, text: string): Promise<string> {
  const numbers = parseStickerNumbers(text);

  if (numbers.length === 0) {
    return "No pude leer números válidos. Mándame las láminas separadas por coma, por ejemplo: 12, 45, 78, 102";
  }

  await saveStickers(user.id, numbers);
  const name = user.name || "amigo";

  // Cruzar con inventario
  const { availableNumbers, unavailableNumbers } = await checkInventory(numbers);

  let response = `¡Listo, *${name}*! Registré *${numbers.length}* láminas que necesitas.\n\n`;

  if (availableNumbers.length > 0) {
    response += `✅ *Tenemos ${availableNumbers.length} disponibles:* ${availableNumbers.join(", ")}\n`;
  }

  if (unavailableNumbers.length > 0) {
    response += `❌ *No tenemos ${unavailableNumbers.length}:* ${unavailableNumbers.join(", ")}\n`;
  }

  if (availableNumbers.length > 0) {
    response += `\nTe avisaremos cómo conseguirlas. `;
  }

  response += `\nSi quieres actualizar tu lista, escribe *actualizar*.`;

  return response;
}

async function handleDone(user: User): Promise<string> {
  const name = user.name || "amigo";
  return (
    `*${name}*, ya estás registrado. Si quieres cambiar tus láminas, ` +
    `escribe *actualizar*.\n\nEscribe *ayuda* para ver todos los comandos.`
  );
}

// Helper interno para cambiar estado sin tocar otros campos
import prisma from "../lib/prisma";

async function updateStep(userId: string, step: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingStep: step },
  });
}
