import prisma from "../lib/prisma";
import { getPrismaMissingTableName, isPrismaMissingTableError } from "../lib/prisma-errors";
import { getChargeStatus } from "./tpaga";
import { processPaymentFromStatus } from "./payment-processor";
import { logTpagaWebhookInfo, logTpagaWebhookError } from "./tpaga-webhook-logger";
import { findOrderByTpagaToken } from "./users";

/** Delays entre intentos de reconciliación (ms): ~30s, 2min, 5min */
export const RECONCILE_DELAYS_MS = [30_000, 120_000, 300_000] as const;

const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "local"}-${process.pid}`;
const LOCK_STALE_MS = 5 * 60 * 1000;
const WORKER_TICK_MS = 60_000;

let workerTimer: NodeJS.Timeout | null = null;
let workerDisabledForSchema = false;

function handleReconciliationWorkerError(error: unknown): void {
  if (isPrismaMissingTableError(error)) {
    const table = getPrismaMissingTableName(error) ?? "desconocida";
    if (!workerDisabledForSchema) {
      workerDisabledForSchema = true;
      console.error(
        `[Tpaga Webhook] reconciliation_worker_disabled table=${table} ` +
          "Ejecuta: npx prisma migrate deploy"
      );
      stopReconciliationWorker();
    }
    return;
  }

  logTpagaWebhookError(
    "reconciliation_worker_tick_failed",
    { source: "reconciliation" },
    error
  );
}

async function runReconciliationWorkerTick(): Promise<void> {
  if (workerDisabledForSchema) return;

  try {
    await processDueReconciliations();
  } catch (error) {
    handleReconciliationWorkerError(error);
  }
}

/**
 * Encola o reactiva reconciliación persistente en BD.
 * Sobrevive reinicios, redeploys y múltiples instancias.
 */
export async function enqueueReconciliation(params: {
  chargeToken: string;
  orderId?: string | null;
  webhookEventId?: string | null;
  /** Si true, el primer intento puede ejecutarse de inmediato */
  immediate?: boolean;
}): Promise<void> {
  const now = new Date();
  const nextAttemptAt = new Date(
    now.getTime() + (params.immediate ? 0 : RECONCILE_DELAYS_MS[0])
  );

  const order =
    params.orderId != null
      ? null
      : await findOrderByTpagaToken(params.chargeToken);
  const orderId = params.orderId ?? order?.id ?? null;

  const existing = await prisma.tpagaReconciliation.findUnique({
    where: { chargeToken: params.chargeToken },
  });

  if (!existing) {
    await prisma.tpagaReconciliation.create({
      data: {
        chargeToken: params.chargeToken,
        orderId,
        webhookEventId: params.webhookEventId ?? null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: RECONCILE_DELAYS_MS.length,
        nextAttemptAt,
      },
    });

    logTpagaWebhookInfo("reconciliation_enqueued", {
      chargeToken: params.chargeToken,
      orderId: orderId ?? undefined,
      source: "reconciliation",
    });
    return;
  }

  if (existing.status === "COMPLETED") {
    const linkedOrder =
      orderId != null
        ? await prisma.order.findUnique({
            where: { id: orderId },
            select: { status: true },
          })
        : await findOrderByTpagaToken(params.chargeToken);

    if (linkedOrder && linkedOrder.status !== "PAID") {
      await prisma.tpagaReconciliation.update({
        where: { chargeToken: params.chargeToken },
        data: {
          status: "PENDING",
          attempts: 0,
          nextAttemptAt,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        },
      });
      logTpagaWebhookInfo("reconciliation_reactivated_from_completed", {
        chargeToken: params.chargeToken,
        orderId: orderId ?? undefined,
        source: "reconciliation",
      });
    }
    return;
  }

  const shouldReactivate =
    existing.status === "EXHAUSTED" ||
    existing.status === "PENDING" ||
    existing.status === "PROCESSING";

  if (!shouldReactivate) {
    return;
  }

  await prisma.tpagaReconciliation.update({
    where: { chargeToken: params.chargeToken },
    data: {
      status: "PENDING",
      orderId: orderId ?? existing.orderId,
      webhookEventId: params.webhookEventId ?? existing.webhookEventId,
      nextAttemptAt:
        existing.nextAttemptAt > now && existing.status === "PENDING"
          ? existing.nextAttemptAt
          : nextAttemptAt,
      attempts: existing.status === "EXHAUSTED" ? 0 : existing.attempts,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  });

  logTpagaWebhookInfo("reconciliation_reactivated", {
    chargeToken: params.chargeToken,
    orderId: orderId ?? existing.orderId ?? undefined,
    source: "reconciliation",
  });
}

/** Libera locks PROCESSING obsoletos (multi-instancia / crash). */
export async function releaseStaleReconciliationLocks(): Promise<number> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const result = await prisma.tpagaReconciliation.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: staleBefore },
    },
    data: {
      status: "PENDING",
      lockedAt: null,
      lockedBy: null,
    },
  });
  return result.count;
}

/**
 * Claim atómico PENDING → PROCESSING.
 * Si claimed.count === 0, otra instancia ganó la carrera.
 */
export async function claimNextReconciliationJob() {
  await releaseStaleReconciliationLocks();

  const now = new Date();
  const due = await prisma.tpagaReconciliation.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: 10,
  });

  const job = due.find((row) => row.attempts < row.maxAttempts) ?? null;
  if (!job) {
    return null;
  }

  const claimed = await prisma.tpagaReconciliation.updateMany({
    where: {
      id: job.id,
      status: "PENDING",
    },
    data: {
      status: "PROCESSING",
      lockedAt: now,
      lockedBy: WORKER_ID,
    },
  });

  if (claimed.count !== 1) {
    return null;
  }

  return job;
}

async function completeReconciliation(chargeToken: string): Promise<void> {
  await prisma.tpagaReconciliation.updateMany({
    where: { chargeToken },
    data: {
      status: "COMPLETED",
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

async function scheduleNextReconciliationAttempt(
  chargeToken: string,
  attempts: number,
  lastError: string | null
): Promise<void> {
  const row = await prisma.tpagaReconciliation.findUnique({
    where: { chargeToken },
  });
  if (!row) return;

  if (attempts >= row.maxAttempts) {
    await prisma.tpagaReconciliation.update({
      where: { chargeToken },
      data: {
        status: "EXHAUSTED",
        attempts,
        lastError: lastError?.substring(0, 500) ?? null,
        lockedAt: null,
        lockedBy: null,
      },
    });
    logTpagaWebhookInfo("reconciliation_exhausted", {
      chargeToken,
      source: "reconciliation",
    });
    return;
  }

  const delay =
    RECONCILE_DELAYS_MS[Math.min(attempts, RECONCILE_DELAYS_MS.length - 1)];

  await prisma.tpagaReconciliation.update({
    where: { chargeToken },
    data: {
      status: "PENDING",
      attempts,
      nextAttemptAt: new Date(Date.now() + delay),
      lastError: lastError?.substring(0, 500) ?? null,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

export async function runReconciliationJob(
  job: NonNullable<Awaited<ReturnType<typeof claimNextReconciliationJob>>>
): Promise<void> {
  const attemptNumber = job.attempts + 1;

  logTpagaWebhookInfo("reconciliation_attempt", {
    chargeToken: job.chargeToken,
    orderId: job.orderId ?? undefined,
    source: "reconciliation",
  });

  try {
    const chargeStatus = await getChargeStatus(job.chargeToken);

    const processed = await processPaymentFromStatus({
      chargeToken: job.chargeToken,
      status: chargeStatus.status,
      rejectedReason: chargeStatus.rejectedReason,
      orderIdHint: job.orderId,
      source: "reconciliation",
      webhookEventId: job.webhookEventId ?? undefined,
    });

    if (processed) {
      await completeReconciliation(job.chargeToken);
      logTpagaWebhookInfo("reconciliation_completed", {
        chargeToken: job.chargeToken,
        status: chargeStatus.status,
        source: "reconciliation",
      });
      return;
    }

    await scheduleNextReconciliationAttempt(
      job.chargeToken,
      attemptNumber,
      `Estado aún no final: ${chargeStatus.status}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTpagaWebhookError(
      "reconciliation_attempt_failed",
      { chargeToken: job.chargeToken, source: "reconciliation" },
      error
    );
    await scheduleNextReconciliationAttempt(
      job.chargeToken,
      attemptNumber,
      message
    );
  }
}

/**
 * Garantías (ver docs/TPAGA_WEBHOOK_TESTS.md):
 * - claim: updateMany WHERE status=PENDING (atómico entre instancias)
 * - locks obsoletos: releaseStaleReconciliationLocks()
 * - errores: scheduleNextReconciliationAttempt libera PROCESSING → PENDING
 * - EXHAUSTED: enqueueReconciliation reinicia attempts a 0
 * - PAID: settleOrderPayment no descuenta si status=PAID
 */

/**
 * Procesa todas las reconciliaciones vencidas (invocado por el worker periódico).
 */
export async function processDueReconciliations(): Promise<number> {
  let processed = 0;

  for (let i = 0; i < 5; i++) {
    const job = await claimNextReconciliationJob();
    if (!job) break;
    await runReconciliationJob(job);
    processed++;
  }

  return processed;
}

/**
 * Worker global: revisa la cola en BD cada 60s (no polling por transacción).
 */
export function startReconciliationWorker(): void {
  if (workerTimer) return;

  logTpagaWebhookInfo("reconciliation_worker_started", {
    source: "reconciliation",
  });

  void runReconciliationWorkerTick();

  workerTimer = setInterval(() => {
    void runReconciliationWorkerTick();
  }, WORKER_TICK_MS);

  workerTimer.unref?.();
}

export function stopReconciliationWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
