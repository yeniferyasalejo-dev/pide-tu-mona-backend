import prisma from "../lib/prisma";

export async function findOrCreateUser(chatId: string) {
  return prisma.user.upsert({
    where: { telegramChatId: chatId },
    update: {},
    create: { telegramChatId: chatId, onboardingStep: "START" },
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
  await prisma.stickerNeeded.deleteMany({ where: { userId } });

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
