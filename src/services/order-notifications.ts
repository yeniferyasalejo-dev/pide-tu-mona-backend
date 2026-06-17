import prisma from "../lib/prisma";

export type NotificationDeliveryStatus =
  | "PENDING"
  | "PROCESSING"
  | "SENT"
  | "FAILED";

const NOTIFICATION_LOCK_STALE_MS = 10 * 60 * 1000;

async function releaseStaleEmailClaims(orderId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - NOTIFICATION_LOCK_STALE_MS);
  await prisma.order.updateMany({
    where: {
      id: orderId,
      confirmationEmailStatus: "PROCESSING",
      confirmationEmailClaimedAt: { lt: staleBefore },
    },
    data: {
      confirmationEmailStatus: "PENDING",
      confirmationEmailClaimedAt: null,
    },
  });
}

async function releaseStaleChatClaims(orderId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - NOTIFICATION_LOCK_STALE_MS);
  await prisma.order.updateMany({
    where: {
      id: orderId,
      userNotificationStatus: "PROCESSING",
      userNotificationClaimedAt: { lt: staleBefore },
    },
    data: {
      userNotificationStatus: "PENDING",
      userNotificationClaimedAt: null,
    },
  });
}

export async function claimConfirmationEmailProcessing(
  orderId: string
): Promise<boolean> {
  await releaseStaleEmailClaims(orderId);

  const result = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: "PAID",
      confirmationEmailStatus: { in: ["PENDING", "FAILED"] },
    },
    data: {
      confirmationEmailStatus: "PROCESSING",
      confirmationEmailClaimedAt: new Date(),
      confirmationEmailAttempts: { increment: 1 },
    },
  });

  return result.count > 0;
}

export async function markConfirmationEmailSent(orderId: string): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      confirmationEmailStatus: "SENT",
      confirmationEmailSentAt: new Date(),
      confirmationEmailLastError: null,
      confirmationEmailClaimedAt: null,
    },
  });
}

export async function markConfirmationEmailFailed(
  orderId: string,
  error: string
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      confirmationEmailStatus: "FAILED",
      confirmationEmailLastError: error.substring(0, 500),
      confirmationEmailClaimedAt: null,
    },
  });
}

export async function claimUserChatNotificationProcessing(
  orderId: string,
  orderStatus: "PAID" | "FAILED"
): Promise<boolean> {
  await releaseStaleChatClaims(orderId);

  const result = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: orderStatus,
      userNotificationStatus: { in: ["PENDING", "FAILED"] },
    },
    data: {
      userNotificationStatus: "PROCESSING",
      userNotificationClaimedAt: new Date(),
      userNotificationAttempts: { increment: 1 },
    },
  });

  return result.count > 0;
}

export async function markUserChatNotificationSent(orderId: string): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      userNotificationStatus: "SENT",
      userNotificationSentAt: new Date(),
      userNotificationLastError: null,
      userNotificationClaimedAt: null,
    },
  });
}

export async function markUserChatNotificationFailed(
  orderId: string,
  error: string
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      userNotificationStatus: "FAILED",
      userNotificationLastError: error.substring(0, 500),
      userNotificationClaimedAt: null,
    },
  });
}
