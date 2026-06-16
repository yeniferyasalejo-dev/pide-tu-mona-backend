import prisma from "../lib/prisma";
import { STICKER_PRICE, DELIVERY_FEE, PSE_FEE } from "../utils/validators";

export class OrderAlreadySettledError extends Error {
  constructor(orderId: string) {
    super(`Orden ${orderId} ya fue procesada por otro proceso`);
    this.name = "OrderAlreadySettledError";
  }
}

export async function findOrCreateUser(chatId: string, channel: "telegram" | "whatsapp" = "telegram") {
  if (channel === "whatsapp") {
    return prisma.user.upsert({
      where: { whatsappPhone: chatId },
      update: {},
      create: { whatsappPhone: chatId, channel: "whatsapp", onboardingStep: "START" },
      include: { stickersNeeded: true },
    });
  }

  return prisma.user.upsert({
    where: { telegramChatId: chatId },
    update: {},
    create: { telegramChatId: chatId, channel: "telegram", onboardingStep: "START" },
    include: { stickersNeeded: true },
  });
}

export async function updateUserName(userId: string, name: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { name, onboardingStep: "WAITING_EMAIL" },
  });
}

export async function updateUserEmail(userId: string, email: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { email, onboardingStep: "WAITING_STICKERS" },
  });
}

export async function saveStickers(userId: string, stickerCodes: string[]) {
  // Se acumulan las láminas — no se borran las anteriores
  for (const code of stickerCodes) {
    await prisma.stickerNeeded.upsert({
      where: { userId_stickerCode: { userId, stickerCode: code } },
      update: {},
      create: { userId, stickerCode: code },
    });
  }

  return prisma.user.update({
    where: { id: userId },
    data: { onboardingStep: "DONE" },
  });
}

export async function removePurchasedStickers(userId: string, stickerCodes: string[]) {
  if (stickerCodes.length === 0) return;
  return prisma.stickerNeeded.deleteMany({
    where: { userId, stickerCode: { in: stickerCodes } },
  });
}

export async function resetToWaitingStickers(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { onboardingStep: "WAITING_STICKERS" },
  });
}

export async function getAllUsers() {
  return prisma.user.findMany({
    include: { stickersNeeded: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: { stickersNeeded: true },
  });
}

// Cruzar láminas que pide el usuario con el inventario
export async function checkInventory(stickerCodes: string[]) {
  const available = await prisma.inventory.findMany({
    where: {
      stickerCode: { in: stickerCodes },
      quantity: { gt: 0 },
    },
  });

  const availableCodes = available.map((item) => item.stickerCode);
  const unavailableCodes = stickerCodes.filter(
    (code) => !availableCodes.includes(code)
  );

  return { available, availableCodes, unavailableCodes };
}

/**
 * Obtiene las láminas del usuario que están disponibles en inventario
 */
export async function getAvailableStickersForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { stickersNeeded: true },
  });

  if (!user || user.stickersNeeded.length === 0) return [];

  const codes = user.stickersNeeded.map((s) => s.stickerCode);
  const available = await prisma.inventory.findMany({
    where: { stickerCode: { in: codes }, quantity: { gt: 0 } },
  });

  return available.map((i) => i.stickerCode);
}

/**
 * Crea una orden de compra
 */
export async function createOrder(userId: string, stickerCodes: string[], deliveryAddress?: string) {
  const totalAmount = stickerCodes.length * STICKER_PRICE + DELIVERY_FEE;

  return prisma.order.create({
    data: {
      userId,
      totalAmount,
      status: "PENDING",
      deliveryAddress: deliveryAddress || null,
      items: {
        create: stickerCodes.map((code) => ({
          stickerCode: code,
          unitPrice: STICKER_PRICE,
        })),
      },
    },
    include: { items: true },
  });
}

/**
 * Actualiza una orden con datos de Tpaga
 */
export async function updateOrderWithTpaga(
  orderId: string,
  data: { tpagaChargeToken: string; tpagaBankUrl: string; bankCode: string }
) {
  return prisma.order.update({
    where: { id: orderId },
    data: {
      tpagaChargeToken: data.tpagaChargeToken,
      tpagaBankUrl: data.tpagaBankUrl,
      bankCode: data.bankCode,
      status: "PROCESSING",
    },
  });
}

/**
 * Busca una orden por ID
 */
export async function findOrderById(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, user: true },
  });
}

/**
 * Busca una orden por token de Tpaga
 */
export async function findOrderByTpagaToken(chargeToken: string) {
  return prisma.order.findFirst({
    where: { tpagaChargeToken: chargeToken },
    include: { items: true, user: true },
  });
}

/**
 * Marca una orden como pagada (solo si aún está pendiente o en procesamiento).
 * Retorna true si esta invocación fue la que actualizó el estado.
 */
export async function markOrderPaid(orderId: string): Promise<boolean> {
  const result = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "PAID" },
  });
  return result.count > 0;
}

/**
 * Marca una orden como fallida (solo si aún está pendiente o en procesamiento).
 * Retorna true si esta invocación fue la que actualizó el estado.
 */
export async function markOrderFailed(orderId: string): Promise<boolean> {
  const result = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "FAILED" },
  });
  return result.count > 0;
}

/**
 * Descuenta láminas del inventario (solo las que tienen stock)
 */
export async function discountInventory(stickerCodes: string[]): Promise<{
  discounted: string[];
  outOfStock: string[];
}> {
  const discounted: string[] = [];
  const outOfStock: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const code of stickerCodes) {
      const result = await tx.inventory.updateMany({
        where: { stickerCode: code, quantity: { gt: 0 } },
        data: { quantity: { decrement: 1 } },
      });

      if (result.count > 0) {
        discounted.push(code);
      } else {
        outOfStock.push(code);
      }
    }
  });

  return { discounted, outOfStock };
}

/**
 * Confirma el pago de una orden de forma atómica:
 * descuenta inventario, limpia el carrito y marca la orden como PAID en una sola transacción.
 */
export async function settleOrderPayment(
  orderId: string,
  userId: string,
  stickerCodes: string[]
): Promise<{ settled: boolean; discounted: string[]; outOfStock: string[] }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (!order || order.status === "PAID" || order.status === "FAILED") {
      return { settled: false, discounted: [], outOfStock: [] };
    }

    const discounted: string[] = [];
    const outOfStock: string[] = [];

    for (const code of stickerCodes) {
      const result = await tx.inventory.updateMany({
        where: { stickerCode: code, quantity: { gt: 0 } },
        data: { quantity: { decrement: 1 } },
      });

      if (result.count > 0) {
        discounted.push(code);
      } else {
        outOfStock.push(code);
      }
    }

    if (discounted.length > 0) {
      await tx.stickerNeeded.deleteMany({
        where: { userId, stickerCode: { in: discounted } },
      });
    }

    const paid = await tx.order.updateMany({
      where: { id: orderId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "PAID" },
    });

    if (paid.count === 0) {
      throw new OrderAlreadySettledError(orderId);
    }

    return { settled: true, discounted, outOfStock };
  });
}

/**
 * Busca la orden pendiente del usuario
 */
export async function findPendingOrder(userId: string) {
  return prisma.order.findFirst({
    where: { userId, status: { in: ["PENDING", "PROCESSING"] } },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Actualiza el paso del usuario
 */
export async function updateUserStep(userId: string, step: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { onboardingStep: step },
  });
}
