import Groq from "groq-sdk";

const GROQ_KEY = process.env.GROQ_API_KEY || "";
const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY, timeout: 5000 }) : null;

const SYSTEM_PROMPT = `Eres el asistente de "Pide Tu Mona", una plataforma para intercambiar monas (láminas/stickers) del álbum del Mundial 2026.

Tu personalidad:
- Eres amigable, entusiasta y conocedor del fútbol
- Hablas en español informal pero respetuoso
- Usas emojis con moderación (1-2 por mensaje)
- Tus respuestas son CORTAS (máximo 2-3 oraciones)
- Nunca inventas información sobre inventario o disponibilidad

Tu trabajo es hacer las respuestas del bot más naturales y amigables.
NO cambies la información factual, solo haz el mensaje más humano.`;

/**
 * Toma una respuesta del bot y la hace más natural con IA
 * Si falla o no hay API key, retorna la respuesta original
 */
export async function humanizeResponse(
  originalResponse: string,
  userMessage: string,
  context: string
): Promise<string> {
  if (!groq) {
    console.log("[AI] No GROQ_API_KEY, usando respuesta original");
    return originalResponse;
  }

  try {
    const result = await Promise.race([
      groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `El usuario escribió: "${userMessage}"
Contexto: ${context}

La respuesta que el bot generó es:
${originalResponse}

Reescribe esta respuesta de forma más natural y amigable, manteniendo TODA la información exacta (números, láminas, datos). No agregues información nueva. Mantén el formato Markdown (*negritas*) para datos importantes. Máximo 3-4 oraciones.`,
          },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 5s")), 5000)
      ),
    ]);

    const text = result?.choices?.[0]?.message?.content;
    if (text && text.length > 0) {
      return text;
    }

    return originalResponse;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AI] Error humanizando:", msg);
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
  if (!groq) {
    return `*${userName}*, escribe *ayuda* para ver los comandos disponibles.`;
  }

  try {
    const result = await Promise.race([
      groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `El usuario ${userName} escribió: "${userMessage}"

Están en la plataforma Pide Tu Mona (intercambio de monas del Mundial 2026).
El usuario ya completó su registro.

Responde de forma breve y amigable. Si preguntan algo que no puedes responder, dile que escriba "ayuda" para ver los comandos.
Comandos disponibles: actualizar (cambiar lista de láminas), paises (ver códigos), ayuda.
Máximo 2-3 oraciones.`,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 5s")), 5000)
      ),
    ]);

    const text = result?.choices?.[0]?.message?.content;
    if (text && text.length > 0) {
      return text;
    }

    return `*${userName}*, no entendí tu mensaje. Escribe *ayuda* para ver los comandos disponibles.`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AI] Error en chat libre:", msg);
    return `*${userName}*, escribe *ayuda* para ver los comandos disponibles.`;
  }
}
