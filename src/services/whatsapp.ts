import axios from "axios";

const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY || "";
const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL || "";
const WHATSAPP_SENDER = process.env.WHATSAPP_SENDER || "";

function getBaseUrl(): string {
  if (!INFOBIP_BASE_URL) throw new Error("Falta INFOBIP_BASE_URL en .env");
  const base = INFOBIP_BASE_URL.startsWith("http")
    ? INFOBIP_BASE_URL
    : `https://${INFOBIP_BASE_URL}`;
  return base.replace(/\/$/, "");
}

function getHeaders() {
  if (!INFOBIP_API_KEY) throw new Error("Falta INFOBIP_API_KEY en .env");
  return {
    Authorization: `App ${INFOBIP_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Verifica si WhatsApp está configurado
 */
export function isWhatsAppEnabled(): boolean {
  return !!(INFOBIP_API_KEY && INFOBIP_BASE_URL && WHATSAPP_SENDER);
}

/**
 * Envía un mensaje de texto por WhatsApp
 */
export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<void> {
  try {
    const res = await axios.post(
      `${getBaseUrl()}/whatsapp/1/message/text`,
      {
        from: WHATSAPP_SENDER,
        to,
        content: { text: message },
      },
      { headers: getHeaders(), timeout: 10000 }
    );
    console.log(`[WhatsApp] Mensaje enviado a ${to}: ${res.data?.messages?.[0]?.messageId || "ok"}`);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error(
        `[WhatsApp] Error enviando a ${to}:`,
        error.response?.data || error.message
      );
    } else {
      console.error(`[WhatsApp] Error enviando a ${to}:`, error);
    }
  }
}

/**
 * Envía un mensaje con botones interactivos (máximo 3 botones)
 */
export async function sendWhatsAppButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
  header?: string,
  footer?: string
): Promise<void> {
  try {
    const content: Record<string, unknown> = {
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((btn) => ({
          type: "REPLY",
          id: btn.id,
          title: btn.title.substring(0, 20),
        })),
      },
    };

    if (header) content.header = { type: "TEXT", text: header.substring(0, 60) };
    if (footer) content.footer = { text: footer.substring(0, 60) };

    const res = await axios.post(
      `${getBaseUrl()}/whatsapp/1/message/interactive/buttons`,
      { from: WHATSAPP_SENDER, to, content },
      { headers: getHeaders(), timeout: 10000 }
    );
    console.log(`[WhatsApp] Botones enviados a ${to}: ${res.data?.messages?.[0]?.messageId || "ok"}`);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error(
        `[WhatsApp] Error enviando botones a ${to}:`,
        error.response?.data || error.message
      );
    } else {
      console.error(`[WhatsApp] Error enviando botones a ${to}:`, error);
    }
  }
}

/**
 * Envía un mensaje con lista interactiva (hasta 10 opciones)
 */
export async function sendWhatsAppList(
  to: string,
  body: string,
  buttonText: string,
  sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
  header?: string,
  footer?: string
): Promise<void> {
  try {
    const content: Record<string, unknown> = {
      body: { text: body },
      action: {
        title: buttonText.substring(0, 20),
        sections: sections.map((section) => ({
          title: section.title.substring(0, 24),
          rows: section.rows.slice(0, 10).map((row) => ({
            id: row.id,
            title: row.title.substring(0, 24),
            description: row.description?.substring(0, 72),
          })),
        })),
      },
    };

    if (header) content.header = { type: "TEXT", text: header.substring(0, 60) };
    if (footer) content.footer = { text: footer.substring(0, 60) };

    const res = await axios.post(
      `${getBaseUrl()}/whatsapp/1/message/interactive/list`,
      { from: WHATSAPP_SENDER, to, content },
      { headers: getHeaders(), timeout: 10000 }
    );
    console.log(`[WhatsApp] Lista enviada a ${to}: ${res.data?.messages?.[0]?.messageId || "ok"}`);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error(
        `[WhatsApp] Error enviando lista a ${to}:`,
        error.response?.data || error.message
      );
    } else {
      console.error(`[WhatsApp] Error enviando lista a ${to}:`, error);
    }
  }
}
