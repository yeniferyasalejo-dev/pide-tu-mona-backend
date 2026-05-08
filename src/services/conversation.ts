import { User } from "@prisma/client";
import {
  updateUserName,
  updateUserEmail,
  saveStickers,
  checkInventory,
} from "./users";
import { isValidEmail, parseStickerCodes, VALID_COUNTRIES } from "../utils/validators";
import { interpretMessage } from "./ai";

const HELP_MESSAGE = `📋 *Comandos disponibles:*

• *paises* — Ver la lista de códigos de países
• *ayuda* o */ayuda* — Muestra este menú
• Manda tus láminas en cualquier momento, ej: \`MEX6, COL12\`

Si tienes dudas, escribe *ayuda* en cualquier momento.`;

const COUNTRIES_MESSAGE = `🌍 *Códigos de países:*

${Object.entries(VALID_COUNTRIES)
  .map(([code, name]) => `*${code}* — ${name}`)
  .join("\n")}

📌 *Especiales:*
*FWC* — FIFA World Cup History (9-19)
*C* — Coca-Cola (1-14)

Ejemplo: \`MEX6, ARG12, FWC15, C7\`
También puedes escribir: \`mexico 6, argentina 12\``;

export async function processMessage(
  user: User,
  text: string
): Promise<string> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Comandos globales
  if (lower === "ayuda" || lower === "/ayuda" || lower === "/help") {
    return HELP_MESSAGE;
  }

  if (lower === "paises" || lower === "/paises") {
    return COUNTRIES_MESSAGE;
  }

  // Comando /start — reinicia
  if (lower === "/start") {
    await updateStep(user.id, "START");
    return handleStart(user);
  }

  switch (user.onboardingStep) {
    case "START":
      return handleStart(user);
    case "WAITING_NAME":
      return handleName(user, trimmed);
    case "WAITING_EMAIL":
      return handleEmail(user, trimmed);
    case "WAITING_STICKERS":
      return handleStickers(user, trimmed);
    case "DONE":
      return handleDone(user, trimmed);
    default:
      return "Algo salió mal. Escribe *ayuda* para ver los comandos disponibles.";
  }
}

async function handleStart(user: User): Promise<string> {
  await updateStep(user.id, "WAITING_NAME");
  return (
    "¡Hola! 👋 Bienvenido a *Pide Tu Mona*, tu lugar para conseguir " +
    "las monas del álbum del Mundial 2026. ⚽\n\n¿Cómo te llamas?"
  );
}

async function handleName(user: User, text: string): Promise<string> {
  if (text.length < 2 || text.length > 100) {
    return "Por favor, mándame un nombre válido (entre 2 y 100 caracteres).";
  }
  await updateUserName(user.id, text);
  return `¡Mucho gusto, *${text}*! 😄 ¿Cuál es tu correo electrónico?`;
}

async function handleEmail(user: User, text: string): Promise<string> {
  if (!isValidEmail(text)) {
    return "Ese correo no parece válido 🤔 Mándame uno correcto, por ejemplo: juan@gmail.com";
  }
  await updateUserEmail(user.id, text.trim().toLowerCase());
  return (
    "¡Perfecto! 📋 Ahora dime qué láminas necesitas, separadas por coma.\n\n" +
    "Puedes escribir el nombre del país o el código:\n" +
    "• `colombia 12, mexico 6, brasil 5`\n" +
    "• `COL12, MEX6, BRA5`\n" +
    "• `FWC15` (FIFA History) o `C7` (Coca-Cola)\n\n" +
    "Escribe *paises* para ver todos los códigos."
  );
}

async function handleStickers(user: User, text: string): Promise<string> {
  if (text.trim().toLowerCase() === "paises" || text.trim().toLowerCase() === "/paises") {
    return COUNTRIES_MESSAGE;
  }

  let codes = parseStickerCodes(text);

  // Si el parser no detecta nada, intentar con AI
  if (codes.length === 0) {
    try {
      const aiResult = await interpretMessage(text, user.name || "amigo", "WAITING_STICKERS");
      if (aiResult.type === "stickers" && aiResult.codes.length > 0) {
        codes = aiResult.codes;
      }
    } catch (error) {
      console.error("[Conversation] AI error in handleStickers:", error);
    }
  }

  if (codes.length === 0) {
    return (
      "No entendí las láminas 😅 Prueba así:\n\n" +
      "• `colombia 12, mexico 6`\n" +
      "• `COL12, MEX6, FWC15, C7`\n" +
      "• `me faltan todas las de cocacola`\n\n" +
      "Escribe *paises* para ver los códigos."
    );
  }

  await saveStickers(user.id, codes);
  const name = user.name || "amigo";

  const { availableCodes, unavailableCodes } = await checkInventory(codes);

  let response = `¡Listo, *${name}*! 📝 Registré *${codes.length}* láminas.\n\n`;

  if (availableCodes.length > 0) {
    response += `✅ *Tenemos ${availableCodes.length}:* ${availableCodes.join(", ")}\n`;
  }

  if (unavailableCodes.length > 0) {
    response += `❌ *No tenemos ${unavailableCodes.length}:* ${unavailableCodes.join(", ")}\n`;
  }

  if (availableCodes.length > 0) {
    response += `\n📩 Te avisaremos cómo conseguirlas.`;
  }

  response += `\n\nSi necesitas más, solo mándame la lista.`;

  return response;
}

async function handleDone(user: User, text: string): Promise<string> {
  const name = user.name || "amigo";

  // Primero intentar parsear láminas directamente (rápido, sin AI)
  const codes = parseStickerCodes(text);
  if (codes.length > 0) {
    return handleStickers(user, text);
  }

  // Si no son láminas detectables, usar AI para interpretar
  try {
    const aiResult = await interpretMessage(text, name, "DONE");

    if (aiResult.type === "stickers" && aiResult.codes.length > 0) {
      // La AI detectó que pide láminas, procesarlas
      await saveStickers(user.id, aiResult.codes);
      const { availableCodes, unavailableCodes } = await checkInventory(aiResult.codes);

      let response = `¡Listo, *${name}*! 📝 Registré *${aiResult.codes.length}* láminas.\n\n`;

      if (availableCodes.length > 0) {
        response += `✅ *Tenemos ${availableCodes.length}:* ${availableCodes.join(", ")}\n`;
      }

      if (unavailableCodes.length > 0) {
        response += `❌ *No tenemos ${unavailableCodes.length}:* ${unavailableCodes.join(", ")}\n`;
      }

      if (availableCodes.length > 0) {
        response += `\n📩 Te avisaremos cómo conseguirlas.`;
      }

      response += `\n\nSi necesitas más, solo mándame la lista.`;
      return response;
    }

    if (aiResult.type === "chat" && aiResult.reply) {
      return aiResult.reply;
    }
  } catch (error) {
    console.error("[Conversation] AI error:", error);
  }

  // Fallback si la AI falla
  return (
    `¡Hola *${name}*! 👋 No entendí tu mensaje.\n\n` +
    `Si quieres pedir láminas, escríbelas así: \`colombia 12, mexico 6\`\n` +
    `Escribe *ayuda* para ver los comandos.`
  );
}

// Helper interno
import prisma from "../lib/prisma";

async function updateStep(userId: string, step: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingStep: step },
  });
}
