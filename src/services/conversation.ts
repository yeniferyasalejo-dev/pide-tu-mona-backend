import { User } from "@prisma/client";
import {
  updateUserName,
  updateUserEmail,
  saveStickers,
  checkInventory,
  getAvailableStickersForUser,
  createOrder,
  updateOrderWithTpaga,
  findPendingOrder,
  markOrderFailed,
  updateUserStep,
} from "./users";
import { isValidEmail, parseStickerCodes, VALID_COUNTRIES } from "../utils/validators";
import { interpretMessage } from "./ai";
import { isTpagaEnabled, getBanks, createCharge } from "./tpaga";

const APP_BASE_URL = process.env.APP_BASE_URL || "";

const HELP_MESSAGE = `📋 *Comandos disponibles:*

• *paises* — Ver la lista de códigos de países
• *comprar* — Comprar las láminas disponibles
• *ayuda* o */ayuda* — Muestra este menú
• Manda tus láminas en cualquier momento, ej: \`MEX6, COL12\`

Precio: *$5,000 COP* por lámina 💰`;

const COUNTRIES_MESSAGE = `🌍 *Códigos de países:*

${Object.entries(VALID_COUNTRIES)
  .map(([code, name]) => `*${code}* — ${name}`)
  .join("\n")}

📌 *Especiales:*
*FWC* — FIFA World Cup History (9-19)
*C* — Coca-Cola (1-14)

Ejemplo: \`MEX6, ARG12, FWC15, C7\`
También puedes escribir: \`mexico 6, argentina 12\``;

// Cache temporal de bancos por usuario (para seleccion)
const userBanksCache = new Map<string, { code: string; name: string }[]>();

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

  // Comando cancelar — cancela compra en cualquier estado de compra
  if (lower === "cancelar") {
    const purchaseStates = ["WAITING_PURCHASE_CONFIRM", "WAITING_BANK_SELECTION", "WAITING_DOCUMENT", "WAITING_PAYMENT"];
    if (purchaseStates.includes(user.onboardingStep)) {
      const pendingOrder = await findPendingOrder(user.id);
      if (pendingOrder) {
        await markOrderFailed(pendingOrder.id);
      }
      await updateStep(user.id, "DONE");
      return `Compra cancelada. Si necesitas más láminas, solo mándame la lista. 👍`;
    }
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
    case "WAITING_PURCHASE_CONFIRM":
      return handlePurchaseConfirm(user, trimmed);
    case "WAITING_BANK_SELECTION":
      return handleBankSelection(user, trimmed);
    case "WAITING_DOCUMENT":
      return handleDocument(user, trimmed);
    case "WAITING_PAYMENT":
      return handleWaitingPayment(user, trimmed);
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
    const total = new Intl.NumberFormat("es-CO").format(availableCodes.length * 5000);
    response += `💰 *Total: $${total} COP* ($5,000 c/u)\n`;
  }

  if (unavailableCodes.length > 0) {
    response += `❌ *No tenemos ${unavailableCodes.length}:* ${unavailableCodes.join(", ")}\n`;
  }

  if (availableCodes.length > 0) {
    response += `\nEscribe *comprar* para comprar las disponibles. 🛒`;
  }

  response += `\nSi necesitas más, solo mándame la lista.`;

  return response;
}

async function handleDone(user: User, text: string): Promise<string> {
  const name = user.name || "amigo";
  const lower = text.toLowerCase().trim();

  // Comando comprar
  if (lower === "comprar") {
    return startPurchaseFlow(user);
  }

  // Primero intentar parsear láminas directamente (rápido, sin AI)
  const codes = parseStickerCodes(text);
  if (codes.length > 0) {
    return handleStickers(user, text);
  }

  // Si no son láminas detectables, usar AI para interpretar
  try {
    const aiResult = await interpretMessage(text, name, "DONE");

    if (aiResult.type === "stickers" && aiResult.codes.length > 0) {
      await saveStickers(user.id, aiResult.codes);
      const { availableCodes, unavailableCodes } = await checkInventory(aiResult.codes);

      let response = `¡Listo, *${name}*! 📝 Registré *${aiResult.codes.length}* láminas.\n\n`;

      if (availableCodes.length > 0) {
        response += `✅ *Tenemos ${availableCodes.length}:* ${availableCodes.join(", ")}\n`;
        const total = new Intl.NumberFormat("es-CO").format(availableCodes.length * 5000);
        response += `💰 *Total: $${total} COP* ($5,000 c/u)\n`;
      }

      if (unavailableCodes.length > 0) {
        response += `❌ *No tenemos ${unavailableCodes.length}:* ${unavailableCodes.join(", ")}\n`;
      }

      if (availableCodes.length > 0) {
        response += `\nEscribe *comprar* para comprar las disponibles. 🛒`;
      }

      response += `\nSi necesitas más, solo mándame la lista.`;
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
    `Escribe *comprar* si ya tienes láminas registradas.\n` +
    `Escribe *ayuda* para ver los comandos.`
  );
}

// ==================== FLUJO DE COMPRA ====================

async function startPurchaseFlow(user: User): Promise<string> {
  const name = user.name || "amigo";

  if (!isTpagaEnabled()) {
    return (
      `*${name}*, los pagos en línea estarán disponibles muy pronto! 🚧\n\n` +
      `Por ahora, contáctanos por Telegram para coordinar tu compra.`
    );
  }

  // Obtener láminas disponibles del usuario
  const availableCodes = await getAvailableStickersForUser(user.id);

  if (availableCodes.length === 0) {
    return (
      `*${name}*, no tienes láminas disponibles para comprar 😅\n\n` +
      `Primero dime qué láminas necesitas, ej: \`COL12, MEX6\``
    );
  }

  const total = availableCodes.length * 5000;
  const totalFormatted = new Intl.NumberFormat("es-CO").format(total);

  await updateStep(user.id, "WAITING_PURCHASE_CONFIRM");

  return (
    `🛒 *Resumen de compra:*\n\n` +
    `Láminas: *${availableCodes.length}*\n` +
    `${availableCodes.join(", ")}\n\n` +
    `💰 *Total: $${totalFormatted} COP* ($5,000 c/u)\n\n` +
    `¿Deseas continuar?\n` +
    `• Escribe *si* para pagar\n` +
    `• Escribe *cancelar* para cancelar`
  );
}

async function handlePurchaseConfirm(user: User, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === "si" || lower === "sí") {
    // Obtener bancos y mostrar lista
    try {
      const banks = await getBanks();
      userBanksCache.set(user.id, banks);

      let msg = `🏦 *Selecciona tu banco:*\n\n`;
      banks.forEach((bank, index) => {
        msg += `*${index + 1}.* ${bank.name}\n`;
      });
      msg += `\nEscribe el *número* de tu banco.`;

      await updateStep(user.id, "WAITING_BANK_SELECTION");
      return msg;
    } catch (error) {
      console.error("[Conversation] Error obteniendo bancos:", error);
      await updateStep(user.id, "DONE");
      return "Hubo un error cargando los bancos. Intenta de nuevo escribiendo *comprar*.";
    }
  }

  if (lower === "no" || lower === "cancelar") {
    await updateStep(user.id, "DONE");
    return "Compra cancelada. Si necesitas más láminas, solo mándame la lista. 👍";
  }

  return "Escribe *si* para continuar con la compra o *cancelar* para cancelar.";
}

async function handleBankSelection(user: User, text: string): Promise<string> {
  const banks = userBanksCache.get(user.id);
  if (!banks || banks.length === 0) {
    await updateStep(user.id, "DONE");
    return "Algo salió mal con los bancos. Escribe *comprar* para intentar de nuevo.";
  }

  const selection = parseInt(text.trim());
  if (isNaN(selection) || selection < 1 || selection > banks.length) {
    return `Escribe un número entre *1* y *${banks.length}* para seleccionar tu banco.`;
  }

  const selectedBank = banks[selection - 1];

  // Guardar banco seleccionado temporalmente y pedir documento
  userBanksCache.set(user.id + "_bank", [selectedBank]);
  await updateStep(user.id, "WAITING_DOCUMENT");

  return (
    `Banco: *${selectedBank.name}* ✅\n\n` +
    `Necesito tus datos para el pago PSE:\n` +
    `Escribe tu *cédula* (solo números).\n\n` +
    `Ejemplo: \`1234567890\``
  );
}

async function handleDocument(user: User, text: string): Promise<string> {
  const docNumber = text.trim().replace(/\D/g, "");

  if (docNumber.length < 5 || docNumber.length > 15) {
    return "Número de documento no válido. Escribe solo los números de tu cédula.";
  }

  const name = user.name || "amigo";
  const bankData = userBanksCache.get(user.id + "_bank");
  if (!bankData || bankData.length === 0) {
    await updateStep(user.id, "DONE");
    return "Algo salió mal. Escribe *comprar* para intentar de nuevo.";
  }

  const selectedBank = bankData[0];

  // Obtener láminas disponibles
  const availableCodes = await getAvailableStickersForUser(user.id);
  if (availableCodes.length === 0) {
    await updateStep(user.id, "DONE");
    return "Ya no hay láminas disponibles para comprar. Intenta más tarde.";
  }

  // Crear la orden en la base de datos
  const order = await createOrder(user.id, availableCodes);

  try {
    // Crear cobro en Tpaga
    const redirectUrl = APP_BASE_URL
      ? `${APP_BASE_URL}/payment/status?token=${order.id}`
      : "https://t.me/mundial26_bot";

    const charge = await createCharge({
      bankCode: selectedBank.code,
      orderId: order.id,
      amount: order.totalAmount,
      description: `Pide Tu Mona - ${availableCodes.length} laminas`,
      buyerEmail: user.email || "sin@email.com",
      buyerFullName: name,
      documentType: "CC",
      documentNumber: docNumber,
      buyerPhone: "3000000000",
      redirectUrl,
    });

    // Actualizar orden con datos de Tpaga
    await updateOrderWithTpaga(order.id, {
      tpagaChargeToken: charge.token,
      tpagaBankUrl: charge.bankUrl,
      bankCode: selectedBank.code,
    });

    await updateStep(user.id, "WAITING_PAYMENT");

    // Limpiar cache
    userBanksCache.delete(user.id);
    userBanksCache.delete(user.id + "_bank");

    return (
      `💳 *Pago listo!*\n\n` +
      `Haz clic aquí para pagar en tu banco:\n` +
      `${charge.bankUrl}\n\n` +
      `⏰ Tienes *30 minutos* para completar el pago.\n` +
      `Te avisaré cuando se confirme. 🔔\n\n` +
      `Escribe *cancelar* si quieres cancelar.`
    );
  } catch (error) {
    console.error("[Conversation] Error creando cobro:", error);
    await markOrderFailed(order.id);
    await updateStep(user.id, "DONE");
    return "Hubo un error creando el pago. Intenta de nuevo escribiendo *comprar*.";
  }
}

async function handleWaitingPayment(user: User, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === "cancelar") {
    const pendingOrder = await findPendingOrder(user.id);
    if (pendingOrder) {
      await markOrderFailed(pendingOrder.id);
    }
    await updateStep(user.id, "DONE");
    return "Compra cancelada. Si necesitas más láminas, solo mándame la lista. 👍";
  }

  return (
    "⏳ Estamos esperando la confirmación de tu pago.\n\n" +
    "Si ya pagaste, espera unos minutos.\n" +
    "Si no has pagado, busca el link que te envié arriba.\n\n" +
    "Escribe *cancelar* para cancelar la compra."
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
