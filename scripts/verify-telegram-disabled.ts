/**
 * Pruebas de deshabilitación segura de Telegram.
 * Uso: npx ts-node scripts/verify-telegram-disabled.ts
 * Opcional (notificaciones de pago): DATABASE_URL=postgresql://...
 */
import axios from "axios";
import { randomUUID } from "crypto";

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

function saveEnv(): Record<string, string | undefined> {
  return {
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadTelegramModule() {
  delete require.cache[require.resolve("../src/services/telegram-config")];
  delete require.cache[require.resolve("../src/services/telegram")];
  return require("../src/services/telegram") as typeof import("../src/services/telegram");
}

async function testDisabledExplicit(): Promise<void> {
  const saved = saveEnv();
  process.env.TELEGRAM_ENABLED = "false";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  let axiosCalls = 0;
  const originalPost = axios.post;
  axios.post = (async (...args: unknown[]) => {
    axiosCalls++;
    return { data: { ok: true } };
  }) as typeof axios.post;

  try {
    const telegram = await loadTelegramModule();
    assert(telegram.isTelegramEnabled() === false, "disabled_flag", "TELEGRAM_ENABLED=false");
    assert(telegram.canRunTelegramInfra() === false, "disabled_infra", "infra no disponible");

    const result = await telegram.sendTelegramMessage("123", "hola");
    assert("skipped" in result && result.reason === "disabled", "disabled_send", "envío omitido");
    assert(axiosCalls === 0, "disabled_no_http", "sin llamadas HTTP a Telegram");
  } finally {
    axios.post = originalPost;
    restoreEnv(saved);
  }
}

async function testDisabledByDefault(): Promise<void> {
  const saved = saveEnv();
  delete process.env.TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;

  try {
    const telegram = await loadTelegramModule();
    assert(telegram.isTelegramEnabled() === false, "absent_defaults_false", "sin variable = deshabilitado");
    const result = await telegram.sendTelegramMessage("123", "hola");
    assert("skipped" in result && result.reason === "disabled", "absent_send_skip", "envío omitido sin variable");
  } finally {
    restoreEnv(saved);
  }
}

async function testEnabledMisconfigured(): Promise<void> {
  const saved = saveEnv();
  process.env.TELEGRAM_ENABLED = "true";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  let axiosCalls = 0;
  const originalPost = axios.post;
  axios.post = (async () => {
    axiosCalls++;
    return { data: { ok: true } };
  }) as typeof axios.post;

  try {
    const telegram = await loadTelegramModule();
    assert(telegram.canRunTelegramInfra() === false, "misconfigured_infra", "infra bloqueada sin credenciales");

    const validation = telegram.validateTelegramConfig();
    assert(!validation.ok, "misconfigured_validation", "validación falla sin token/chat ID");

    const result = await telegram.sendTelegramMessage("123", "hola");
    assert("skipped" in result && result.reason === "misconfigured", "misconfigured_send", "envío omitido");
    assert(axiosCalls === 0, "misconfigured_no_http", "sin HTTP con credenciales faltantes");
  } finally {
    axios.post = originalPost;
    restoreEnv(saved);
  }
}

async function testEnabledWithCredentials(): Promise<void> {
  const saved = saveEnv();
  process.env.TELEGRAM_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "999";

  const posts: string[] = [];
  const originalPost = axios.post;
  axios.post = (async (url: string) => {
    posts.push(String(url));
    return { data: { ok: true, result: { message_id: 1 } } };
  }) as typeof axios.post;

  try {
    const telegram = await loadTelegramModule();
    assert(telegram.canRunTelegramInfra() === true, "enabled_infra", "infra disponible con credenciales");

    const result = await telegram.sendTelegramMessage("12345", "pago ok");
    assert("sent" in result, "enabled_send", "mensaje enviado con credenciales");
    assert(posts.length === 1, "enabled_http_once", "una llamada HTTP a api.telegram.org");
    assert(posts[0].includes("api.telegram.org"), "enabled_telegram_api", "usa API de Telegram");
  } finally {
    axios.post = originalPost;
    restoreEnv(saved);
  }
}

async function testUserMessagingWhatsAppIndependent(): Promise<void> {
  const saved = saveEnv();
  process.env.TELEGRAM_ENABLED = "false";
  delete process.env.TELEGRAM_BOT_TOKEN;

  delete require.cache[require.resolve("../src/services/telegram")];
  delete require.cache[require.resolve("../src/services/whatsapp")];
  delete require.cache[require.resolve("../src/services/user-messaging")];

  const whatsapp = require("../src/services/whatsapp") as {
    sendWhatsAppMessage: (phone: string, msg: string) => Promise<void>;
  };
  let whatsappCalls = 0;
  whatsapp.sendWhatsAppMessage = async () => {
    whatsappCalls++;
  };

  const { sendUserChatMessage } = require("../src/services/user-messaging") as typeof import("../src/services/user-messaging");

  const waResult = await sendUserChatMessage(
    { channel: "whatsapp", whatsappPhone: "573001234567" },
    "confirmado"
  );
  assert(waResult.delivered && waResult.channel === "whatsapp", "whatsapp_works", "WhatsApp sigue funcionando");
  assert(whatsappCalls === 1, "whatsapp_called", "WhatsApp invocado");

  const tgResult = await sendUserChatMessage(
    { channel: "telegram", telegramChatId: "123" },
    "confirmado"
  );
  assert(
    !tgResult.delivered && tgResult.skipped && tgResult.reason === "disabled",
    "telegram_user_skipped",
    "usuario Telegram omitido sin error"
  );

  restoreEnv(saved);
}

async function testPaymentNotificationNotFailed(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    pass("payment_notification_db", "omitido (sin DATABASE_URL)");
    return;
  }

  const saved = saveEnv();
  process.env.TELEGRAM_ENABLED = "false";
  delete process.env.TELEGRAM_BOT_TOKEN;

  delete require.cache[require.resolve("../src/services/telegram")];
  delete require.cache[require.resolve("../src/services/user-messaging")];
  delete require.cache[require.resolve("../src/services/payment-processor")];

  const prisma = (await import("../src/lib/prisma")).default;
  const { processPaymentFromStatus } = await import("../src/services/payment-processor");

  const email = require("../src/services/email") as { sendPurchaseConfirmation: () => Promise<void> };
  email.sendPurchaseConfirmation = async () => {};

  const chargeToken = `tg-off-${randomUUID()}`;
  const stickerCode = `TG-${randomUUID().slice(0, 8)}`;

  let user;
  let order;
  try {
    user = await prisma.user.create({
    data: {
      telegramChatId: `tg-${randomUUID()}`,
      channel: "telegram",
      name: "Tester TG Off",
      email: `tg-off-${randomUUID()}@example.com`,
      onboardingStep: "DONE",
    },
  });

    order = await prisma.order.create({
    data: {
      userId: user.id,
      status: "PENDING",
      paymentMethod: "PSE",
      totalAmount: 1500,
      tpagaChargeToken: chargeToken,
      confirmationEmailStatus: "PENDING",
      userNotificationStatus: "PENDING",
      items: { create: [{ stickerCode, unitPrice: 1500 }] },
    },
  });

  await prisma.inventory.upsert({
    where: { stickerCode },
    create: { stickerCode, quantity: 5 },
    update: { quantity: 5 },
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Can't reach database server")) {
      pass("payment_notification_db", "omitido (BD no disponible)");
      restoreEnv(saved);
      await prisma.$disconnect();
      return;
    }
    throw error;
  }

  try {
    await processPaymentFromStatus({
      chargeToken,
      status: "settled",
      source: "webhook",
      orderIdHint: order.id,
    });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    assert(updated?.status === "PAID", "payment_not_blocked", "PSE completó con PAID");
    assert(updated?.userNotificationStatus === "SENT", "notification_not_failed", "userNotificationStatus no quedó FAILED");
    assert(updated?.userNotificationStatus !== "FAILED", "notification_no_fail", "Telegram deshabilitado no marca FAILED");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Can't reach database server")) {
      pass("payment_notification_db", "omitido (BD no disponible)");
      return;
    }
    throw error;
  } finally {
    await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.inventory.delete({ where: { stickerCode } }).catch(() => {});
    restoreEnv(saved);
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("=== Verificación Telegram deshabilitado ===\n");

  try {
    await testDisabledExplicit();
    await testDisabledByDefault();
    await testEnabledMisconfigured();
    await testEnabledWithCredentials();
    await testUserMessagingWhatsAppIndependent();
    await testPaymentNotificationNotFailed();
  } catch (error) {
    console.error("\nVerificación abortada:", error instanceof Error ? error.message : error);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Resumen: ${results.length - failed.length}/${results.length} OK ===`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

void main();
