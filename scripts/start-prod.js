/**
 * Arranque en producción: intenta migraciones y luego levanta la app.
 * Si migrate falla por red (P1001) pero las tablas ya existen (SQL manual), continúa.
 */
const { spawnSync } = require("child_process");

function warnDirectUrlMisconfigured() {
  const direct = process.env.DIRECT_URL || "";
  const database = process.env.DATABASE_URL || "";

  if (direct.includes("db.") && direct.includes(".supabase.co:5432")) {
    console.warn(
      "[Prisma] DIRECT_URL usa db.*.supabase.co — Railway suele no alcanzar ese host.\n" +
        "Cambia DIRECT_URL a Session pooler puerto 5432:\n" +
        "  postgresql://...@aws-1-us-west-2.pooler.supabase.com:5432/postgres\n" +
        "(mismo usuario/contraseña que DATABASE_URL, sin ?pgbouncer=true)"
    );
  }

  if (!direct && database.includes(":6543")) {
    console.warn(
      "[Prisma] Sin DIRECT_URL y DATABASE_URL es pooler :6543. " +
        "Define DIRECT_URL con Session pooler :5432 o aplica migraciones en Supabase SQL Editor."
    );
  }
}

function runMigrate() {
  if (process.env.PRISMA_SKIP_MIGRATE === "true") {
    console.log("[Prisma] PRISMA_SKIP_MIGRATE=true — omitiendo migrate deploy");
    return true;
  }

  warnDirectUrlMisconfigured();

  const result = spawnSync(
    "node",
    ["scripts/with-direct-url.js", "npx", "prisma", "migrate", "deploy"],
    { encoding: "utf8", env: process.env, shell: true }
  );

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

  if (result.status === 0) {
    console.log("[Prisma] migrate deploy OK");
    return true;
  }

  if (output.includes("P1001") || /Can't reach database server/i.test(output)) {
    console.error(
      "[Prisma] migrate deploy falló (P1001 — sin conexión a la BD).\n" +
        "Si ya ejecutaste el SQL en Supabase, la app puede arrancar igual.\n" +
        "Corrige DIRECT_URL (Session pooler :5432) o define PRISMA_SKIP_MIGRATE=true"
    );
    return false;
  }

  console.error("[Prisma] migrate deploy falló:\n", output);
  return false;
}

const migrateOk = runMigrate();

if (!migrateOk && process.env.PRISMA_FAIL_ON_MIGRATE === "true") {
  process.exit(1);
}

const app = spawnSync("node", ["dist/start.js"], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

process.exit(app.status === null ? 1 : app.status);
