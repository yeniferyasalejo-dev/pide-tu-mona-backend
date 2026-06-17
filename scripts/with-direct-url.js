/**
 * Prisma exige DIRECT_URL si está en schema.prisma.
 * - build / generate: fallback a DATABASE_URL (no conecta a la BD).
 * - migrate deploy: con pooler Supabase (6543) DIRECT_URL debe estar definida (5432).
 */
const { spawnSync } = require("child_process");

function usesSupabasePooler(url) {
  return url.includes(":6543") || /[?&]pgbouncer=true/i.test(url);
}

function ensureDirectUrl({ requireForPooler = false } = {}) {
  if (process.env.DIRECT_URL?.trim()) {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || "";

  if (requireForPooler && usesSupabasePooler(databaseUrl)) {
    console.error(
      "[Prisma] DIRECT_URL no está definida y DATABASE_URL usa el pooler de Supabase (puerto 6543).\n" +
        "Las migraciones requieren conexión directa (puerto 5432).\n" +
        "Supabase → Settings → Database → Connection string → Direct connection\n" +
        "Agrega DIRECT_URL en Railway con esa URL y vuelve a desplegar."
    );
    process.exit(1);
  }

  if (databaseUrl) {
    process.env.DIRECT_URL = databaseUrl;
    return;
  }

  // Solo para validación del schema en entornos sin BD configurada
  process.env.DIRECT_URL = "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
}

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error("Uso: node scripts/with-direct-url.js <comando> [args...]");
  process.exit(1);
}

const isMigrate = command.includes("prisma") && args.includes("migrate");
ensureDirectUrl({ requireForPooler: isMigrate });

const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
