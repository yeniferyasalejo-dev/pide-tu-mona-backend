import axios from "axios";
import prisma from "../lib/prisma";

const BASE_URL = process.env.TPAGA_BASE_URL || "https://staging.apiv2.tpaga.co";
const CLIENT_ID = process.env.TPAGA_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TPAGA_CLIENT_SECRET || "";
const BANKS_TTL_MS = 24 * 60 * 60 * 1000;

export type BankOption = { code: string; name: string };

// Cache del token JWT (en memoria; se renueva por expires_in)
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// Evita refrescos simultáneos de la lista de bancos
let banksRefreshPromise: Promise<BankOption[]> | null = null;

// L1 en memoria (se pierde al reiniciar; la fuente de verdad es la BD)
let memoryBanks: BankOption[] = [];
let memoryBanksUpdatedAt = 0;

/**
 * Verifica si Tpaga está configurado
 */
export function isTpagaEnabled(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

/**
 * Normaliza un teléfono colombiano para enviarlo a Tpaga (solo dígitos, 10 chars, empieza por 3).
 */
export function normalizeColombianPhone(value?: string | null): string {
  let digits = (value ?? "").replace(/\D/g, "");

  if (digits.startsWith("57") && digits.length === 12) {
    digits = digits.slice(2);
  }

  if (digits.length !== 10 || !digits.startsWith("3")) {
    throw new Error(
      "El número de teléfono de WhatsApp no es válido para PSE. Debe ser un celular colombiano de 10 dígitos que comience por 3."
    );
  }

  return digits;
}

/**
 * Obtiene un token JWT de Tpaga usando OAuth2 client credentials
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const res = await axios.post(
      `${BASE_URL}/o/token/`,
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + (res.data.expires_in || 3600) * 1000;
    console.log("[Tpaga] Token obtenido, expira en", res.data.expires_in, "s");
    return cachedToken!;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Tpaga] Error obteniendo token:", msg);
    throw new Error("No se pudo autenticar con Tpaga");
  }
}

function isValidBankList(banks: unknown): banks is BankOption[] {
  return (
    Array.isArray(banks) &&
    banks.every(
      (b) =>
        b &&
        typeof b === "object" &&
        typeof (b as BankOption).code === "string" &&
        typeof (b as BankOption).name === "string"
    )
  );
}

async function loadBanksFromDatabase(): Promise<{
  banks: BankOption[];
  updatedAt: Date;
} | null> {
  const row = await prisma.pseBankCache.findUnique({
    where: { id: "default" },
  });

  if (!row || !isValidBankList(row.banks)) {
    return null;
  }

  return {
    banks: row.banks as BankOption[],
    updatedAt: row.updatedAt,
  };
}

async function saveBanksToDatabase(banks: BankOption[]): Promise<void> {
  await prisma.pseBankCache.upsert({
    where: { id: "default" },
    create: { id: "default", banks },
    update: { banks },
  });

  memoryBanks = banks;
  memoryBanksUpdatedAt = Date.now();
  console.log(
    `[Tpaga] Lista de bancos persistida (${banks.length} bancos) at=${new Date().toISOString()}`
  );
}

async function fetchBanksFromTpaga(): Promise<BankOption[]> {
  const token = await getAccessToken();

  const res = await axios.get(`${BASE_URL}/api/pse/v1/public/banks`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });

  const banks = res.data.map((b: { name: string; code: string }) => ({
    code: b.code,
    name: b.name,
  }));

  await saveBanksToDatabase(banks);
  return banks;
}

function getMemoryBanksIfFresh(): BankOption[] | null {
  if (
    memoryBanks.length > 0 &&
    Date.now() - memoryBanksUpdatedAt < BANKS_TTL_MS
  ) {
    return memoryBanks;
  }
  return null;
}

/**
 * Obtiene la lista de bancos PSE con caché persistente (TTL 24h).
 * Si Tpaga falla, devuelve la última lista válida almacenada.
 */
export async function getBanks(): Promise<BankOption[]> {
  const fromMemory = getMemoryBanksIfFresh();
  if (fromMemory) {
    return fromMemory;
  }

  const fromDb = await loadBanksFromDatabase();
  if (fromDb && Date.now() - fromDb.updatedAt.getTime() < BANKS_TTL_MS) {
    memoryBanks = fromDb.banks;
    memoryBanksUpdatedAt = fromDb.updatedAt.getTime();
    return fromDb.banks;
  }

  if (!banksRefreshPromise) {
    banksRefreshPromise = (async () => {
      try {
        return await fetchBanksFromTpaga();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Tpaga] Error obteniendo bancos:", msg);

        if (fromDb) {
          console.warn(
            "[Tpaga] Devolviendo lista de bancos en caché (última válida)"
          );
          memoryBanks = fromDb.banks;
          memoryBanksUpdatedAt = fromDb.updatedAt.getTime();
          return fromDb.banks;
        }

        throw new Error("No se pudo obtener la lista de bancos");
      }
    })().finally(() => {
      banksRefreshPromise = null;
    });
  }

  return banksRefreshPromise;
}

/**
 * Crea un cobro PSE
 */
export async function createCharge(params: {
  bankCode: string;
  orderId: string;
  amount: number;
  description: string;
  buyerEmail: string;
  buyerFullName: string;
  documentType: string;
  documentNumber: string;
  buyerPhone: string;
  redirectUrl: string;
  userType?: string;
}): Promise<{
  token: string;
  bankUrl: string;
  status: string;
  traceabilityCode: string;
}> {
  const token = await getAccessToken();

  try {
    const res = await axios.post(
      `${BASE_URL}/api/pse/v1/public/charge`,
      {
        bank_code: params.bankCode,
        order_id: params.orderId.substring(0, 20),
        amount: `${params.amount}.00`,
        vat_amount: "0.00",
        description: params.description.substring(0, 80),
        user_type: params.userType || "NATURAL",
        buyer_email: params.buyerEmail,
        buyer_full_name: params.buyerFullName,
        document_type: params.documentType,
        document_number: params.documentNumber,
        redirect_url: params.redirectUrl,
        buyer_phone_number: params.buyerPhone,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log(`[Tpaga] Cobro creado: ${res.data.token}`);
    return {
      token: res.data.token,
      bankUrl: res.data.bank_url,
      status: res.data.status,
      traceabilityCode: res.data.traceability_code,
    };
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("[Tpaga] Error creando cobro:", {
        operation: "createCharge",
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
    } else {
      console.error("[Tpaga] Error creando cobro:", error);
    }
    throw new Error("No se pudo crear el cobro PSE");
  }
}

/**
 * Consulta el estado de un cobro (solo reconciliación / fallback excepcional).
 */
export async function getChargeStatus(chargeToken: string): Promise<{
  status: string;
  transactionState: string | null;
  rejectedReason: string | null;
}> {
  const mockStatus = process.env.TPAGA_VERIFY_MOCK_CHARGE_STATUS;
  if (mockStatus) {
    return {
      status: mockStatus,
      transactionState: null,
      rejectedReason: mockStatus.includes("reject") ? "mock_rejected" : null,
    };
  }

  const token = await getAccessToken();

  try {
    const res = await axios.get(
      `${BASE_URL}/api/pse/v1/public/charge/${chargeToken}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      }
    );

    return {
      status: res.data.status,
      transactionState: res.data.transaction_state,
      rejectedReason: res.data.rejected_reason,
    };
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("[Tpaga] Error consultando cobro:", {
        operation: "getChargeStatus",
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
    } else {
      console.error("[Tpaga] Error consultando cobro:", error);
    }
    throw new Error("No se pudo consultar el estado del cobro");
  }
}
