import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 10000 })
  : null;

const SYSTEM_PROMPT = `Eres el asistente de "Pide Tu Mona", plataforma para conseguir monas/láminas del álbum del Mundial 2026.

Personalidad: amigable, entusiasta del fútbol, hablas español informal. Usas 1-2 emojis por mensaje. Respuestas CORTAS (máximo 3 oraciones).

REGLAS IMPORTANTES:
- Nunca inventas datos de inventario o disponibilidad
- Si el usuario pide láminas, responde SOLO con el JSON indicado abajo
- Mantén formato Markdown (*negritas*) para datos importantes`;

/**
 * Interpreta mensajes libres del usuario. Si detecta que pide láminas,
 * extrae los códigos. Si no, responde como chat.
 * Tiene un timeout duro de 10 segundos para evitar que se cuelgue.
 */
export async function interpretMessage(
  userMessage: string,
  userName: string,
  currentState: string
): Promise<{ type: "stickers"; codes: string[] } | { type: "chat"; reply: string }> {
  if (!client) {
    console.log("[AI] No OPENAI_API_KEY configurada");
    return { type: "chat", reply: `*${userName}*, escribe *ayuda* para ver los comandos.` };
  }

  try {
    console.log(`[AI] Llamando OpenAI para: "${userMessage.substring(0, 50)}"`);

    // Timeout duro de 10 segundos para que nunca se cuelgue
    const result = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}

El usuario "${userName}" está en estado: ${currentState}.

Si el usuario está pidiendo láminas/monas del álbum, extrae los códigos y responde EXACTAMENTE con este formato JSON:
{"type":"stickers","codes":["COL12","MEX6"]}

Los códigos válidos son:
- País + número (1-20): MEX, RSA, KOR, CZE, CAN, BIH, QAT, SUI, BRA, MAR, HAI, SCO, USA, PAR, AUS, TUR, GER, CUW, CIV, ECU, NED, JPN, SWE, TUN, BEL, EGY, IRN, NZL, ESP, CPV, KSA, URU, FRA, SEN, IRQ, NOR, ARG, ALG, AUT, JOR, POR, COD, UZB, COL, ENG, CRO, GHA, PAN
- FIFA World Cup History: FWC9 a FWC19
- Coca-Cola: C1 a C14

Si dice "todas las de cocacola" → genera C1,C2,...,C14
Si dice "todas las de colombia" → genera COL1,COL2,...,COL20
Si dice "me faltan la 5 y la 10 de mexico" → genera MEX5,MEX10

Si NO está pidiendo láminas (saludo, pregunta, etc), responde con:
{"type":"chat","reply":"tu respuesta amigable aquí"}`,
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 10s")), 10000)
      ),
    ]);

    const text = result?.choices?.[0]?.message?.content?.trim() || "";
    console.log(`[AI] Respuesta OpenAI: "${text.substring(0, 100)}"`);

    // Intentar parsear como JSON
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "stickers" && Array.isArray(parsed.codes) && parsed.codes.length > 0) {
        return { type: "stickers", codes: parsed.codes };
      }
      if (parsed.type === "chat" && parsed.reply) {
        return { type: "chat", reply: parsed.reply };
      }
    } catch {
      // No era JSON, usar como respuesta de chat
    }

    return { type: "chat", reply: text || `*${userName}*, escribe *ayuda* para ver los comandos.` };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AI] Error:", msg);
    return { type: "chat", reply: `*${userName}*, no pude procesar tu mensaje. Prueba escribir las láminas así: \`COL12, MEX6\`` };
  }
}
