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

export async function saveStickers(userId: string, stickerNumbers: number[]) {
  await prisma.stickerNeeded.deleteMany({ where: { userId } });

  for (const num of stickerNumbers) {
    await prisma.stickerNeeded.upsert({
      where: { userId_stickerNumber: { userId, stickerNumber: num } },
      update: {},
      create: { userId, stickerNumber: num },
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
export async function checkInventory(stickerNumbers: number[]) {
  const available = await prisma.inventory.findMany({
    where: {
      stickerNumber: { in: stickerNumbers },
      quantity: { gt: 0 },
    },
  });

  const availableNumbers = available.map((item) => item.stickerNumber);
  const unavailableNumbers = stickerNumbers.filter(
    (num) => !availableNumbers.includes(num)
  );

  return { available, availableNumbers, unavailableNumbers };
}
