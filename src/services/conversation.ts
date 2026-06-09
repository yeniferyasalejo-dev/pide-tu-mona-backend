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
import { isValidEmail, parseStickerCodes, detectOutOfRange, VALID_COUNTRIES, STICKER_PRICE, STICKER_PRICE_FORMATTED, DELIVERY_FEE, DELIVERY_FEE_FORMATTED, PSE_FEE, PSE_FEE_FORMATTED } from "../utils/validators";
import { interpretMessage, addToHistory, clearHistory } from "./ai";
import { isTpagaEnabled, getBanks, createCharge } from "./tpaga";

const APP_BASE_URL = process.env.APP_BASE_URL || "";

// ==================== DETECCIÓN DE INTENCIÓN ====================

/**
 * Detecta si el usuario quiere comprar/pagar
 * Ej: "comprar", "pagar", "quiero comprar", "listo para pagar", "dale compro"
 */
function isIntentPurchase(text: string): boolean {
  // Palabras cortas — solo como mensaje completo
  const exactOnly = ["dale", "listo", "va", "vamos"];
  if (exactOnly.includes(text)) return true;

  // Frases que pueden estar contenidas
  const phrases = [
    "comprar", "compro", "pagar", "pago", "quiero comprar",
    "voy a comprar", "dale compro", "listo para pagar",
    "quiero pagar", "vamos a pagar", "le doy", "hagale",
    "hágale", "quiero las laminas", "quiero las láminas",
    "si compro", "sí compro", "las quiero",
  ];
  return phrases.some(kw => text.includes(kw));
}

/**
 * Detecta si el usuario dice sí/confirma
 * Ej: "si", "sí", "dale", "claro", "pagar", "comprar", "correcto"
 */
function isIntentYes(text: string): boolean {
  // Palabras cortas — solo como mensaje completo para evitar falsos positivos
  const exactOnly = [
    "si", "sí", "dale", "ok", "okay", "okey", "va", "eso",
    "listo", "perfecto", "claro", "sigue",
  ];
  if (exactOnly.includes(text)) return true;

  // Frases que pueden estar contenidas
  const phrases = [
    "correcto", "confirmo", "confirmar", "vamos",
    "hagale", "hágale", "pagar", "comprar",
    "si claro", "claro que si", "claro que sí",
    "por supuesto", "afirmativo", "todo bien",
    "esta bien", "está bien", "de una",
    "si señor", "sí señor", "si señora", "sí señora",
    "adelante", "proceder", "continuar",
  ];
  return phrases.some(kw => text.includes(kw));
}

/**
 * Detecta si el usuario quiere ver su carrito
 * Ej: "carrito", "que llevo", "cuantas llevo", "mi lista"
 */
function isIntentCart(text: string): boolean {
  const keywords = [
    "carrito", "mi carrito", "ver carrito", "que llevo",
    "qué llevo", "cuantas llevo", "cuántas llevo",
    "mi lista", "mis laminas", "mis láminas",
    "que tengo", "qué tengo", "cuantas tengo", "cuántas tengo",
    "mi pedido", "ver pedido", "resumen",
  ];
  return keywords.some(kw => text === kw || text.includes(kw));
}

/**
 * Detecta si el usuario quiere cancelar
 * Ej: "cancelar", "no", "no quiero", "dejalo", "olvídalo"
 */
function isIntentCancel(text: string): boolean {
  // Palabras exactas (solo si el mensaje completo es esta palabra)
  const exactOnly = ["no", "nada", "paso", "nel"];
  if (exactOnly.includes(text)) return true;

  // Frases que pueden estar contenidas en el mensaje
  const phrases = [
    "cancelar", "cancela", "no quiero", "dejalo",
    "déjalo", "olvidalo", "olvídalo", "ya no",
    "no gracias", "mejor no",
  ];
  return phrases.some(kw => text.includes(kw));
}

const HELP_MESSAGE = `📋 *¿En qué te puedo ayudar?*

• Mándame las láminas que necesitas, ej: \`colombia 12, mexico 6\`
• Escribe *carrito* para ver tus láminas acumuladas
• Escribe *paises* para ver los códigos
• Escribe *comprar* cuando quieras pagar
• Escribe *ayuda* si te pierdes

💰 Cada lámina cuesta *$${STICKER_PRICE_FORMATTED} COP*
📦 Te las enviamos a tu dirección`;

const COUNTRIES_MESSAGE = `🌍 *Códigos de países:*

${Object.entries(VALID_COUNTRIES)
  .map(([code, name]) => `*${code}* — ${name}`)
  .join("\n")}

📌 *Especiales:*
*FWC* — FIFA World Cup History (9-19)
*C* — Coca-Cola (1-14)

Ejemplo: \`MEX6, ARG12, FWC15, C7\`
También puedes escribir: \`mexico 6, argentina 12\``;

// Cache temporal de bancos y dirección por usuario
const userBanksCache = new Map<string, { code: string; name: string }[]>();
const userAddressCache = new Map<string, string>();

export async function processMessage(
  user: User,
  text: string
): Promise<string> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Guardar mensaje del usuario en historial
  addToHistory(user.id, "user", trimmed);

  // Helper para guardar respuesta en historial antes de retornar
  const reply = async (response: string | Promise<string>): Promise<string> => {
    const r = await response;
    addToHistory(user.id, "assistant", r.substring(0, 200)); // solo guardar resumen
    return r;
  };

  // Estados que esperan texto libre — saltar directo al handler sin detección de intención
  const freeTextStates = ["WAITING_ADDRESS", "WAITING_NAME", "WAITING_EMAIL", "WAITING_DOCUMENT"];
  if (freeTextStates.includes(user.onboardingStep)) {
    switch (user.onboardingStep) {
      case "WAITING_NAME":
        return reply(handleName(user, trimmed));
      case "WAITING_EMAIL":
        return reply(handleEmail(user, trimmed));
      case "WAITING_ADDRESS":
        return reply(handleAddress(user, trimmed));
      case "WAITING_DOCUMENT":
        return reply(handleDocument(user, trimmed));
    }
  }

  // Comandos globales (solo para estados que NO esperan texto libre)
  if (lower === "ayuda" || lower === "/ayuda" || lower === "/help") {
    return reply(HELP_MESSAGE);
  }

  if (lower === "paises" || lower === "/paises") {
    return reply(COUNTRIES_MESSAGE);
  }

  // Comando carrito — ver láminas acumuladas
  if (isIntentCart(lower)) {
    return reply(handleCart(user));
  }

  // Comando /start — reinicia
  if (lower === "/start") {
    await updateStep(user.id, "START");
    return reply(handleStart(user));
  }

  // Comando cancelar — cancela compra en estados de compra
  if (isIntentCancel(lower)) {
    const purchaseStates = ["WAITING_PURCHASE_CONFIRM", "WAITING_BANK_SELECTION", "WAITING_PAYMENT"];
    if (purchaseStates.includes(user.onboardingStep)) {
      const pendingOrder = await findPendingOrder(user.id);
      if (pendingOrder) {
        await markOrderFailed(pendingOrder.id);
      }
      await updateStep(user.id, "DONE");
      return reply(`Compra cancelada. Si necesitas más láminas, solo mándame la lista. 👍`);
    }
  }

  switch (user.onboardingStep) {
    case "START":
      return reply(handleStart(user));
    case "WAITING_NAME":
      return reply(handleName(user, trimmed));
    case "WAITING_EMAIL":
      return reply(handleEmail(user, trimmed));
    case "WAITING_STICKERS":
      return reply(handleStickers(user, trimmed));
    case "DONE":
      return reply(handleDone(user, trimmed));
    case "WAITING_ADDRESS":
      return reply(handleAddress(user, trimmed));
    case "WAITING_PURCHASE_CONFIRM":
      return reply(handlePurchaseConfirm(user, trimmed));
    case "WAITING_BANK_SELECTION":
      return reply(handleBankSelection(user, trimmed));
    case "WAITING_DOCUMENT":
      return reply(handleDocument(user, trimmed));
    case "WAITING_PAYMENT":
      return reply(handleWaitingPayment(user, trimmed));
    default:
      return reply("Algo salió mal. Escribe *ayuda* para ver los comandos disponibles.");
  }
}

async function handleStart(user: User): Promise<string> {
  await updateStep(user.id, "WAITING_NAME");
  return (
    "¡Hola! 👋 Bienvenido a *Pide Tu Mona*\n\n" +
    "Aquí conseguís las monas que te faltan del álbum del Mundial 2026. ⚽\n\n" +
    "Para empezar, ¿cómo te llamas?"
  );
}

async function handleName(user: User, text: string): Promise<string> {
  // Extraer el nombre limpio (quitar "me llamo", "soy", "mi nombre es", etc.)
  let name = text.trim();
  const prefixes = [
    /^me\s+llamo\s+/i,
    /^mi\s+nombre\s+es\s+/i,
    /^soy\s+/i,
    /^me\s+dicen\s+/i,
    /^me\s+digo\s+/i,
    /^hola,?\s+soy\s+/i,
    /^hola,?\s+me\s+llamo\s+/i,
    /^hola,?\s+mi\s+nombre\s+es\s+/i,
  ];
  for (const prefix of prefixes) {
    name = name.replace(prefix, "");
  }
  name = name.trim();

  if (name.length < 2 || name.length > 100) {
    return "Mmm, no pillé tu nombre 🤔 ¿Cómo te llamas?";
  }

  // Capitalizar primera letra
  name = name.charAt(0).toUpperCase() + name.slice(1);

  await updateUserName(user.id, name);
  return `¡Mucho gusto, *${name}*! 😄\n\n¿Me pasas tu correo electrónico? Lo necesito para enviarte la confirmación de compra.`;
}

async function handleEmail(user: User, text: string): Promise<string> {
  if (!isValidEmail(text)) {
    return "Ese correo no me parece válido 🤔 Prueba de nuevo, ej: juan@gmail.com";
  }
  await updateUserEmail(user.id, text.trim().toLowerCase());
  return (
    "¡Listo! ✅ Ahora sí, dime qué láminas te faltan.\n\n" +
    "Me las puedes escribir como quieras:\n" +
    "• `colombia 12, mexico 6, brasil 5`\n" +
    "• `COL12, MEX6, BRA5`\n" +
    "• O dime algo como: `me faltan todas las de cocacola`\n\n" +
    "Escribe *paises* si quieres ver los códigos. 🌍"
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
      const aiResult = await interpretMessage(text, user.name || "amigo", "WAITING_STICKERS", user.id);
      if (aiResult.type === "stickers" && aiResult.codes.length > 0) {
        codes = aiResult.codes;
      }
    } catch (error) {
      console.error("[Conversation] AI error in handleStickers:", error);
    }
  }

  if (codes.length === 0) {
    // Verificar si el usuario escribió un número fuera de rango
    const outOfRange = detectOutOfRange(text);
    if (outOfRange) return outOfRange;

    return (
      "No pillé cuáles láminas necesitas 😅\n\n" +
      "Prueba escribirlas así:\n" +
      "• `colombia 12, mexico 6`\n" +
      "• `COL12, MEX6, FWC15, C7`\n" +
      "• `me faltan todas las de cocacola`\n\n" +
      "O escribe *paises* para ver los códigos."
    );
  }

  await saveStickers(user.id, codes);
  const name = user.name || "amigo";

  // Obtener TODAS las láminas acumuladas del usuario
  const updatedUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: { stickersNeeded: true },
  });
  const allCodes = updatedUser?.stickersNeeded.map(s => s.stickerCode) || codes;

  const { availableCodes, unavailableCodes } = await checkInventory(allCodes);

  let response = `¡Listo, *${name}*! 📝 Registré *${codes.length}* láminas nuevas.\n`;
  response += `📋 *Total acumulado: ${allCodes.length} láminas*\n\n`;

  if (availableCodes.length > 0) {
    response += `✅ *Tenemos ${availableCodes.length}:* ${availableCodes.join(", ")}\n`;
    const total = new Intl.NumberFormat("es-CO").format(availableCodes.length * STICKER_PRICE);
    response += `💰 *Total: $${total} COP* ($${STICKER_PRICE_FORMATTED} c/u)\n`;
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

  // Comando comprar — detecta variaciones
  if (isIntentPurchase(lower)) {
    return startPurchaseFlow(user);
  }

  // Verificar si escribió láminas con número fuera de rango
  const outOfRange = detectOutOfRange(text);
  if (outOfRange) return outOfRange;

  // Primero intentar parsear láminas directamente (rápido, sin AI)
  const codes = parseStickerCodes(text);
  if (codes.length > 0) {
    return handleStickers(user, text);
  }

  // Si no son láminas detectables, usar AI para interpretar
  try {
    const aiResult = await interpretMessage(text, name, "DONE", user.id);

    if (aiResult.type === "stickers" && aiResult.codes.length > 0) {
      // Reutilizar handleStickers para mantener lógica de acumulación
      return handleStickers(user, text);
    }

    if (aiResult.type === "chat" && aiResult.reply) {
      return aiResult.reply;
    }
  } catch (error) {
    console.error("[Conversation] AI error:", error);
  }

  // Fallback si la AI falla
  return (
    `*${name}*, no te entendí bien 😅\n\n` +
    `¿Necesitas láminas? Escríbelas así: \`colombia 12, mexico 6\`\n` +
    `¿Ya tienes láminas? Escribe *comprar*\n` +
    `¿Perdido? Escribe *ayuda* 🙌`
  );
}

// ==================== CARRITO ====================

async function handleCart(user: User): Promise<string> {
  const name = user.name || "amigo";

  const userData = await prisma.user.findUnique({
    where: { id: user.id },
    include: { stickersNeeded: true },
  });

  const allCodes = userData?.stickersNeeded.map(s => s.stickerCode) || [];

  if (allCodes.length === 0) {
    return (
      `🛒 *Tu carrito está vacío, ${name}.*\n\n` +
      `Mándame las láminas que necesitas, ej: \`colombia 12, mexico 6\``
    );
  }

  const { availableCodes, unavailableCodes } = await checkInventory(allCodes);

  let response = `🛒 *Tu carrito, ${name}:*\n\n`;
  response += `📋 *Total: ${allCodes.length} láminas*\n\n`;

  if (availableCodes.length > 0) {
    response += `✅ *Disponibles (${availableCodes.length}):* ${availableCodes.join(", ")}\n`;
    const subtotal = availableCodes.length * STICKER_PRICE;
    const grandTotal = subtotal + DELIVERY_FEE + PSE_FEE;
    response += `💰 Láminas: $${new Intl.NumberFormat("es-CO").format(subtotal)} COP ($${STICKER_PRICE_FORMATTED} c/u)\n`;
    response += `📦 Envío: $${DELIVERY_FEE_FORMATTED} COP\n`;
    response += `🏦 PSE: $${PSE_FEE_FORMATTED} COP\n`;
    response += `🧾 *Total: $${new Intl.NumberFormat("es-CO").format(grandTotal)} COP*\n`;
  }

  if (unavailableCodes.length > 0) {
    response += `\n❌ *No disponibles (${unavailableCodes.length}):* ${unavailableCodes.join(", ")}\n`;
  }

  if (availableCodes.length > 0) {
    response += `\nEscribe *comprar* para comprar las disponibles. 🛒`;
  }

  response += `\nMándame más láminas para agregarlas.`;

  return response;
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

  const subtotal = availableCodes.length * STICKER_PRICE;
  const grandTotal = subtotal + DELIVERY_FEE + PSE_FEE;
  const subtotalFormatted = new Intl.NumberFormat("es-CO").format(subtotal);
  const grandTotalFormatted = new Intl.NumberFormat("es-CO").format(grandTotal);

  await updateStep(user.id, "WAITING_ADDRESS");

  return (
    `🛒 *Resumen de compra:*\n\n` +
    `Láminas: *${availableCodes.length}*\n` +
    `${availableCodes.join(", ")}\n\n` +
    `💰 *Desglose:*\n` +
    `• Láminas: $${subtotalFormatted} COP ($${STICKER_PRICE_FORMATTED} c/u)\n` +
    `• Envío: $${DELIVERY_FEE_FORMATTED} COP\n` +
    `• Comisión PSE: $${PSE_FEE_FORMATTED} COP\n` +
    `• *Total a pagar: $${grandTotalFormatted} COP*\n\n` +
    `📦 Para la entrega, envíame tus datos en un solo mensaje:\n\n` +
    `Ciudad:\n` +
    `Barrio:\n` +
    `Dirección/Conjunto:\n` +
    `Nombre de quien recibe:\n` +
    `Datos adicionales:\n\n` +
    `Ejemplo:\n` +
    `\`Bogotá\n` +
    `Chapinero\n` +
    `Calle 53 #12-45, Torre 2 Apto 301\n` +
    `María López\n` +
    `Portería abierta hasta las 8pm\`\n\n` +
    `Escribe *cancelar* para cancelar.`
  );
}

async function handleAddress(user: User, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === "cancelar") {
    await updateStep(user.id, "DONE");
    return "Compra cancelada. Si necesitas más láminas, solo mándame la lista. 👍";
  }

  // Validar que tenga al menos algo razonable (mínimo 10 caracteres)
  if (text.length < 10) {
    return (
      "La dirección parece muy corta 🤔\n\n" +
      "Envíame los datos completos: ciudad, barrio, dirección, nombre de quien recibe."
    );
  }

  // Guardar dirección en cache temporal
  userAddressCache.set(user.id, text);

  await updateStep(user.id, "WAITING_PURCHASE_CONFIRM");

  return (
    `📦 *Dirección registrada* ✅\n\n` +
    `${text}\n\n` +
    `¿Todo correcto?\n` +
    `• Escribe *si* para continuar al pago\n` +
    `• Escribe *cancelar* para cancelar`
  );
}

async function handlePurchaseConfirm(user: User, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (isIntentYes(lower)) {
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

  if (isIntentCancel(lower)) {
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

  // Crear la orden en la base de datos con dirección de entrega
  const deliveryAddress = userAddressCache.get(user.id);
  const order = await createOrder(user.id, availableCodes, deliveryAddress);

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
    userAddressCache.delete(user.id);

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
