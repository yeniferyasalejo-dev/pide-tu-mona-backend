import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const SYSTEM_PROMPT = `Eres el asistente de "Pide Tu Mona", una plataforma para intercambiar monas (láminas/stickers) del álbum del Mundial 2026.

Tu personalidad:
- Eres amigable, entusiasta y conocedor del fútbol
- Hablas en español informal pero respetuoso
- Usas emojis con moderación (1-2 por mensaje)
- Tus respuestas son CORTAS (máximo 2-3 oraciones)
- Nunca inventas información sobre inventario o disponibilidad

Tu trabajo es hacer las respuestas del bot más naturales y amigables.
NO cambies la información factual, solo haz el mensaje más humano.`;

const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: SYSTEM_PROMPT,
});

/**
 * Toma una respuesta del bot y la hace más natural con Gemini
 * Si Gemini falla, retorna la respuesta original
 */
export async function humanizeResponse(
  originalResponse: string,
  userMessage: string,
  context: string
): Promise<string> {
  try {
    const prompt = `El usuario escribió: "${userMessage}"
Contexto: ${context}

La respuesta que el bot generó es:
${originalResponse}

Reescribe esta respuesta de forma más natural y amigable, manteniendo TODA la información exacta (números, láminas, datos). No agregues información nueva. Mantén el formato Markdown (*negritas*) para datos importantes. Máximo 3-4 oraciones.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (text && text.length > 0) {
      return text;
    }

    return originalResponse;
  } catch (error) {
    console.error("[Gemini] Error:", error);
    return originalResponse;
  }
}

/**
 * Responde preguntas libres del usuario cuando está en estado DONE
 */
export async function chatFreeform(
  userMessage: string,
  userName: string
): Promise<string> {
  try {
    const prompt = `El usuario ${userName} escribió: "${userMessage}"

Están en la plataforma Pide Tu Mona (intercambio de monas del Mundial 2026).
El usuario ya completó su registro.

Responde de forma breve y amigable. Si preguntan algo que no puedes responder, dile que escriba "ayuda" para ver los comandos.
Comandos disponibles: actualizar (cambiar lista de láminas), paises (ver códigos), ayuda.
Máximo 2-3 oraciones.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (text && text.length > 0) {
      return text;
    }

    return `*${userName}*, no entendí tu mensaje. Escribe *ayuda* para ver los comandos disponibles.`;
  } catch (error) {
    console.error("[Gemini] Error en chat libre:", error);
    return `*${userName}*, escribe *ayuda* para ver los comandos disponibles.`;
  }
}
