/**
 * Verificación final pre-commit: webhook Tpaga, reconciliación y settleOrderPayment.
 * Uso: DATABASE_URL=postgresql://... npx ts-node scripts/verify-tpaga-final.ts
 */
import { randomUUID } from "crypto";
import prisma from "../src/lib/prisma";
import {
  claimNextReconciliationJob,
  enqueueReconciliation,
  processDueReconciliations,
  runReconciliationJob,
} from "../src/services/tpaga-reconciliation";
import { processPaymentFromStatus } from "../src/services/payment-processor";
import { settleOrderPayment } from "../src/services/users";

// Evitar envíos reales durante las pruebas
// eslint-disable-next-line @typescript-eslint/no-require-imports
const email = require("../src/services/email") as {
  sendPurchaseConfirmation: (...args: unknown[]) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const telegram = require("../src/services/telegram") as {
  sendTelegramMessage: (...args: unknown[]) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const whatsapp = require("../src/services/whatsapp") as {
  sendWhatsAppMessage: (...args: unknown[]) => Promise<void>;
};

email.sendPurchaseConfirmation = async () => {};
telegram.sendTelegramMessage = async () => {};
whatsapp.sendWhatsAppMessage = async () => {};

type TestResult = { name: string; ok: boolean; detail: string };

const results: TestResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string): never {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}: ${detail}`);
  throw new Error(detail);
}

function assert(cond: boolean, name: string, detail: string): void {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

async function seedOrder(params: {
  chargeToken: string;
  status?: string;
  stickerCode?: string;
  inventoryQty?: number;
  withCart?: boolean;
}) {
  const stickerCode = params.stickerCode ?? `TST-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      telegramChatId: `tg-${randomUUID()}`,
      channel: "telegram",
      name: "Tester",
      email: `test-${randomUUID()}@example.com`,
      onboardingStep: "DONE",
    },
  });

  const order = await prisma.order.create({
    data: {
      userId: user.id,
      status: params.status ?? "PENDING",
      paymentMethod: "PSE",
      totalAmount: 1500,
      tpagaChargeToken: params.chargeToken,
      deliveryAddress: "Calle Test 1",
      confirmationEmailStatus: "PENDING",
      userNotificationStatus: "PENDING",
      items: {
        create: [{ stickerCode, unitPrice: 1500 }],
      },
    },
    include: { items: true, user: true },
  });

  await prisma.inventory.upsert({
    where: { stickerCode },
    create: { stickerCode, quantity: params.inventoryQty ?? 10 },
    update: { quantity: params.inventoryQty ?? 10 },
  });

  if (params.withCart) {
    await prisma.stickerNeeded.create({
      data: { userId: user.id, stickerCode },
    });
  }

  return { user, order, stickerCode };
}

async function seedWebhookEvent(chargeToken: string, orderId: string) {
  return prisma.tpagaWebhookEvent.create({
    data: {
      idempotencyKey: `${chargeToken}:verify-${randomUUID()}`,
      chargeToken,
      orderId,
      status: null,
      processingStatus: "RECEIVED",
    },
  });
}

async function testClaimRequiresCountOne(): Promise<void> {
  const chargeToken = `claim-${randomUUID()}`;
  const { order } = await seedOrder({ chargeToken });

  await prisma.tpagaReconciliation.create({
    data: {
      chargeToken,
      orderId: order.id,
      status: "PENDING",
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
    },
  });

  const [a, b] = await Promise.all([
    claimNextReconciliationJob(),
    claimNextReconciliationJob(),
  ]);

  const claims = [a, b].filter(Boolean);
  assert(claims.length === 1, "claim_updateMany_count", "solo un worker obtuvo el claim (count === 1)");

  const row = await prisma.tpagaReconciliation.findUnique({ where: { chargeToken } });
  assert(row?.status === "PROCESSING", "claim_status", "job quedó en PROCESSING");

  await prisma.tpagaReconciliation.delete({ where: { chargeToken } });
}

async function testConcurrencyWorkers(): Promise<void> {
  const chargeToken = `conc-${randomUUID()}`;
  const { order } = await seedOrder({ chargeToken, inventoryQty: 5 });
  const event = await seedWebhookEvent(chargeToken, order.id);

  process.env.TPAGA_VERIFY_MOCK_CHARGE_STATUS = "settled";

  await enqueueReconciliation({
    chargeToken,
    orderId: order.id,
    webhookEventId: event.id,
    immediate: true,
  });

  let tpagaCalls = 0;
  const original = require("../src/services/tpaga").getChargeStatus;
  require("../src/services/tpaga").getChargeStatus = async (token: string) => {
    if (token === chargeToken) tpagaCalls++;
    return original(token);
  };

  const workers = await Promise.all(
    Array.from({ length: 2 }, async () => {
      const job = await claimNextReconciliationJob();
      if (!job) return { claimed: false, processed: false };
      await runReconciliationJob(job);
      return { claimed: true, processed: true };
    })
  );

  const claimed = workers.filter((w) => w.claimed).length;
  const processed = workers.filter((w) => w.processed).length;

  const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
  const inv = await prisma.inventory.findFirst({
    where: { stickerCode: order.items[0].stickerCode },
  });

  assert(claimed === 1, "concurrency_claim", "solo un worker reclamó el job");
  assert(tpagaCalls === 1, "concurrency_tpaga", "solo una consulta a Tpaga (mock)");
  assert(processed === 1, "concurrency_process", "solo un worker procesó la orden");
  assert(workers.some((w) => !w.claimed), "concurrency_idle", "el otro worker no ejecutó acciones");
  assert(finalOrder?.status === "PAID", "concurrency_paid", "orden pasó a PAID una sola vez");
  assert(inv?.quantity === 4, "concurrency_inventory", "inventario descontado una sola vez");

  delete process.env.TPAGA_VERIFY_MOCK_CHARGE_STATUS;
}

async function testSettleRollbackAndRetry(): Promise<void> {
  const chargeToken = `rollback-${randomUUID()}`;
  const { user, order, stickerCode } = await seedOrder({
    chargeToken,
    inventoryQty: 7,
    withCart: true,
  });
  const event = await seedWebhookEvent(chargeToken, order.id);

  const invBefore = await prisma.inventory.findUnique({ where: { stickerCode } });
  const cartBefore = await prisma.stickerNeeded.count({ where: { userId: user.id } });

  process.env.TPAGA_VERIFY_FAIL_AFTER_INVENTORY = "1";

  let threw = false;
  try {
    await settleOrderPayment(order.id, user.id, [stickerCode], {
      tpagaStatus: "settled",
      webhookEventId: event.id,
    });
  } catch (e) {
    threw = e instanceof Error && e.message === "TPAGA_VERIFY_FAIL_AFTER_INVENTORY";
  }

  delete process.env.TPAGA_VERIFY_FAIL_AFTER_INVENTORY;

  assert(threw, "rollback_throws", "settleOrderPayment lanzó error forzado tras inventario");

  const orderAfterFail = await prisma.order.findUnique({ where: { id: order.id } });
  const invAfterFail = await prisma.inventory.findUnique({ where: { stickerCode } });
  const cartAfterFail = await prisma.stickerNeeded.count({ where: { userId: user.id } });
  const eventAfterFail = await prisma.tpagaWebhookEvent.findUnique({ where: { id: event.id } });

  assert(orderAfterFail?.status !== "PAID", "rollback_not_paid", "orden no quedó PAID");
  assert(invAfterFail?.quantity === invBefore?.quantity, "rollback_inventory", "inventario no descontado");
  assert(cartAfterFail === cartBefore, "rollback_cart", "carrito no modificado");
  assert(eventAfterFail?.processingStatus !== "PROCESSED", "rollback_event", "evento no quedó PROCESSED");

  const retry = await settleOrderPayment(order.id, user.id, [stickerCode], {
    tpagaStatus: "settled",
    webhookEventId: event.id,
  });

  const invAfterRetry = await prisma.inventory.findUnique({ where: { stickerCode } });
  const orderAfterRetry = await prisma.order.findUnique({ where: { id: order.id } });
  const eventAfterRetry = await prisma.tpagaWebhookEvent.findUnique({ where: { id: event.id } });

  assert(retry.settled, "rollback_retry_ok", "reintento completó correctamente");
  assert(
    invAfterRetry?.quantity === (invBefore?.quantity ?? 0) - 1,
    "rollback_single_discount",
    "inventario descontado una sola vez"
  );
  assert(orderAfterRetry?.status === "PAID", "rollback_retry_paid", "reintento dejó orden PAID");
  assert(eventAfterRetry?.processingStatus === "PROCESSED", "rollback_retry_event", "evento PROCESSED tras reintento");
}

async function testCase10RestartRecovery(): Promise<void> {
  const chargeToken = `restart-${randomUUID()}`;
  const { order } = await seedOrder({ chargeToken, inventoryQty: 3 });
  const event = await seedWebhookEvent(chargeToken, order.id);

  process.env.TPAGA_VERIFY_MOCK_CHARGE_STATUS = "settled";

  await enqueueReconciliation({
    chargeToken,
    orderId: order.id,
    webhookEventId: event.id,
    immediate: true,
  });

  const pending = await prisma.tpagaReconciliation.findUnique({ where: { chargeToken } });
  assert(pending?.status === "PENDING" && pending.attempts === 0, "case10_enqueued", "cola PENDING tras webhook sin status");

  // Simula reinicio: worker nuevo procesa la cola persistida
  const processed = await processDueReconciliations();
  assert(processed >= 1, "case10_worker", "worker post-reinicio procesó la fila");

  const recon = await prisma.tpagaReconciliation.findUnique({ where: { chargeToken } });
  const ord = await prisma.order.findUnique({ where: { id: order.id } });
  const evt = await prisma.tpagaWebhookEvent.findUnique({ where: { id: event.id } });

  assert(recon?.status === "COMPLETED", "case10_completed", "reconciliación COMPLETED");
  assert(ord?.status === "PAID", "case10_paid", "orden PAID tras reconciliación");
  assert(evt?.processingStatus === "PROCESSED", "case10_event", "evento PROCESSED");

  // Webhook duplicado no debe repetir inventario
  const invBeforeDup = await prisma.inventory.findFirst({
    where: { stickerCode: order.items[0].stickerCode },
  });

  await processPaymentFromStatus({
    chargeToken,
    status: "settled",
    source: "webhook",
    webhookEventId: event.id,
    orderIdHint: order.id,
  });

  const invAfterDup = await prisma.inventory.findFirst({
    where: { stickerCode: order.items[0].stickerCode },
  });
  const reconAfterDup = await prisma.tpagaReconciliation.findUnique({ where: { chargeToken } });

  assert(invAfterDup?.quantity === invBeforeDup?.quantity, "case10_no_double_inventory", "sin segundo descuento");
  assert(reconAfterDup?.status === "COMPLETED", "case10_stays_completed", "reconciliación sigue COMPLETED");

  delete process.env.TPAGA_VERIFY_MOCK_CHARGE_STATUS;
}

async function testPaymentStates(): Promise<void> {
  // pending: solo tpaga_status
  {
    const token = `st-pending-${randomUUID()}`;
    const { order } = await seedOrder({ chargeToken: token });
    const inv0 = await prisma.inventory.findFirst({ where: { stickerCode: order.items[0].stickerCode } });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "pending",
      source: "webhook",
      orderIdHint: order.id,
    });

    const o = await prisma.order.findUnique({ where: { id: order.id } });
    const inv1 = await prisma.inventory.findFirst({ where: { stickerCode: order.items[0].stickerCode } });
    assert(o?.status === "PENDING" && o.tpagaStatus === "pending", "state_pending", "pending: solo tpaga_status");
    assert(inv0?.quantity === inv1?.quantity, "state_pending_inv", "pending: sin inventario");
  }

  // authorized: solo tpaga_status
  {
    const token = `st-auth-${randomUUID()}`;
    const { order } = await seedOrder({ chargeToken: token });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "authorized",
      source: "webhook",
      orderIdHint: order.id,
    });

    const o = await prisma.order.findUnique({ where: { id: order.id } });
    assert(o?.status === "PENDING" && o.tpagaStatus === "authorized", "state_authorized", "authorized: solo tpaga_status");
  }

  // rejected: FAILED
  {
    const token = `st-rej-${randomUUID()}`;
    const { order } = await seedOrder({ chargeToken: token });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "charge-rejected",
      rejectedReason: "cancelada",
      source: "webhook",
      orderIdHint: order.id,
    });

    const o = await prisma.order.findUnique({ where: { id: order.id } });
    assert(o?.status === "FAILED", "state_rejected", "rejected: orden FAILED");
  }

  // FAILED + settled: recuperación a PAID
  {
    const token = `st-recover-${randomUUID()}`;
    const { order } = await seedOrder({ chargeToken: token, status: "FAILED", inventoryQty: 4 });
    const invBefore = await prisma.inventory.findFirst({
      where: { stickerCode: order.items[0].stickerCode },
    });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "settled",
      source: "webhook",
      orderIdHint: order.id,
    });

    const o = await prisma.order.findUnique({ where: { id: order.id } });
    const invAfter = await prisma.inventory.findFirst({
      where: { stickerCode: order.items[0].stickerCode },
    });
    assert(o?.status === "PAID", "state_failed_to_paid", "FAILED + settled: orden PAID");
    assert(invAfter?.quantity === (invBefore?.quantity ?? 0) - 1, "state_failed_inv", "FAILED + settled: inventario descontado");
  }

  // settled duplicado: sin repetir inventario ni notificaciones
  {
    const token = `st-dup-${randomUUID()}`;
    const { order } = await seedOrder({ chargeToken: token, inventoryQty: 6 });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "settled",
      source: "webhook",
      orderIdHint: order.id,
    });

    const invMid = await prisma.inventory.findFirst({
      where: { stickerCode: order.items[0].stickerCode },
    });
    const ordMid = await prisma.order.findUnique({ where: { id: order.id } });

    await processPaymentFromStatus({
      chargeToken: token,
      status: "settled",
      source: "webhook",
      orderIdHint: order.id,
    });

    const invEnd = await prisma.inventory.findFirst({
      where: { stickerCode: order.items[0].stickerCode },
    });
    const ordEnd = await prisma.order.findUnique({ where: { id: order.id } });

    assert(ordMid?.status === "PAID" && ordEnd?.status === "PAID", "state_dup_paid", "settled duplicado: sigue PAID");
    assert(invMid?.quantity === invEnd?.quantity, "state_dup_inv", "settled duplicado: sin segundo descuento");
    assert(
      ordEnd?.confirmationEmailStatus === "SENT",
      "state_dup_email",
      "settled duplicado: email marcado SENT sin reintento"
    );
    assert(
      ordEnd?.confirmationEmailAttempts === 1,
      "state_dup_email_attempts",
      "settled duplicado: un solo intento de email"
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL es requerida");
    process.exit(1);
  }

  console.log("=== Verificación final Tpaga ===\n");

  try {
    await testClaimRequiresCountOne();
    await testConcurrencyWorkers();
    await testSettleRollbackAndRetry();
    await testCase10RestartRecovery();
    await testPaymentStates();
  } catch (error) {
    console.error("\nVerificación abortada:", error instanceof Error ? error.message : error);
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Resumen: ${results.length - failed.length}/${results.length} OK ===`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

void main();
