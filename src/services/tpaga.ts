import axios from "axios";

const BASE_URL = process.env.TPAGA_BASE_URL || "https://staging.apiv2.tpaga.co";
const CLIENT_ID = process.env.TPAGA_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TPAGA_CLIENT_SECRET || "";

// Cache del token JWT
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// Cache de bancos (se actualiza cada 24h)
let cachedBanks: { code: string; name: string }[] = [];
let banksUpdatedAt = 0;

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
  // Usar token cacheado si no ha expirado
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

/**
 * Obtiene la lista de bancos disponibles para PSE
 */
export async function getBanks(): Promise<{ code: string; name: string }[]> {
  // Cache de 24 horas
  if (cachedBanks.length > 0 && Date.now() - banksUpdatedAt < 24 * 60 * 60 * 1000) {
    return cachedBanks;
  }

  const token = await getAccessToken();

  try {
    const res = await axios.get(`${BASE_URL}/api/pse/v1/public/banks`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    cachedBanks = res.data.map((b: { name: string; code: string }) => ({
      code: b.code,
      name: b.name,
    }));
    banksUpdatedAt = Date.now();
    console.log(`[Tpaga] ${cachedBanks.length} bancos cargados`);
    return cachedBanks;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Tpaga] Error obteniendo bancos:", msg);
    throw new Error("No se pudo obtener la lista de bancos");
  }
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
 * Consulta el estado de un cobro
 */
export async function getChargeStatus(chargeToken: string): Promise<{
  status: string;
  transactionState: string | null;
  rejectedReason: string | null;
}> {
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
