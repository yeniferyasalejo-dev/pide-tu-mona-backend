import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 10000 })
  : null;

const SYSTEM_PROMPT = `Eres "Mona", la asistente virtual de "Pide Tu Mona", una tienda de láminas/monas del álbum Panini del Mundial FIFA 2026.

PERSONALIDAD:
- Colombiana, amigable, cálida y entusiasta del fútbol ⚽
- Hablas español informal pero respetuoso (tuteas al usuario)
- Usas 1-2 emojis por mensaje, no más
- Respuestas CORTAS y directas (máximo 2-3 oraciones)
- Si te preguntan algo que no sabes, dilo con humor
- Puedes hacer comentarios futboleros cuando sea natural ("¡Vamos Colombia!" etc.)

CONTEXTO DEL NEGOCIO:
- Vendemos láminas del álbum del Mundial 2026 a $1,500 COP cada una
- El cliente pide láminas por Telegram, paga por PSE, y se las entregamos
- Tenemos láminas de 48 países + Coca-Cola (C1-C14) + FIFA World Cup History (FWC9-FWC19)
- Para comprar: el cliente manda la lista de láminas, luego escribe "comprar"

REGLAS:
- NUNCA inventas datos de inventario, precios o disponibilidad
- Si el usuario pide láminas, extrae los códigos en formato JSON
- Si es una conversación normal (saludo, pregunta, queja), responde naturalmente
- Si no entiendes qué láminas pide, pide que aclare con un ejemplo amigable
- Recuerda que "monas" y "láminas" son lo mismo (stickers del álbum)`;

const STICKER_EXTRACTION_PROMPT = `Los códigos válidos de láminas son:
- País + número: MEX, RSA, KOR, CZE, CAN, BIH, QAT, SUI, BRA, MAR, HAI, SCO, USA, PAR, AUS, TUR, GER, CUW, CIV, ECU, NED, JPN, SWE, TUN, BEL, EGY, IRN, NZL, ESP, CPV, KSA, URU, FRA, SEN, IRQ, NOR, ARG, ALG, AUT, JOR, POR, COD, UZB, COL, ENG, CRO, GHA, PAN
- Cada país tiene láminas del 1 al 20
- FIFA World Cup History: FWC9 a FWC19
- Coca-Cola: C1 a C14

Ejemplos de interpretación:
- "todas las de cocacola" → C1,C2,...,C14
- "todas las de colombia" → COL1,COL2,...,COL20
- "me faltan la 5 y la 10 de mexico" → MEX5,MEX10
- "necesito la 3, 7 y 15 de argentina" → ARG3,ARG7,ARG15
- "dame brasil 5 al 10" → BRA5,BRA6,BRA7,BRA8,BRA9,BRA10
- "las que me faltan de fifa son 12, 15 y 18" → FWC12,FWC15,FWC18

Si detectas que el usuario está pidiendo láminas, responde SOLO con este JSON:
{"type":"stickers","codes":["COL12","MEX6"]}

Si NO está pidiendo láminas, responde con:
{"type":"chat","reply":"tu respuesta aquí"}`;

/**
 * Interpreta mensajes libres del usuario. Si detecta que pide láminas,
 * extrae los códigos. Si no, responde como chat natural.
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

    const stateContext = getStateContext(currentState, userName);

    const result = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\n${STICKER_EXTRACTION_PROMPT}\n\n${stateContext}`,
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 10s")), 10000)
      ),
    ]);

    const text = result?.choices?.[0]?.message?.content?.trim() || "";
    console.log(`[AI] Respuesta OpenAI: "${text.substring(0, 100)}"`);

    // Intentar parsear como JSON (puede venir envuelto en ```json)
    const jsonText = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

    try {
      const parsed = JSON.parse(jsonText);
      if (parsed.type === "stickers" && Array.isArray(parsed.codes) && parsed.codes.length > 0) {
        return { type: "stickers", codes: parsed.codes };
      }
      if (parsed.type === "chat" && parsed.reply) {
        return { type: "chat", reply: parsed.reply };
      }
    } catch {
      // No era JSON puro — puede ser respuesta directa
    }

    // Si no es JSON, usar el texto como respuesta de chat
    if (text.length > 0 && !text.startsWith("{")) {
      return { type: "chat", reply: text };
    }

    return { type: "chat", reply: `¡Hola *${userName}*! No entendí bien. ¿Necesitas láminas? Escríbelas así: \`COL12, MEX6\` 😊` };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AI] Error:", msg);
    return { type: "chat", reply: `*${userName}*, tuve un problemita procesando tu mensaje. ¿Puedes intentar de nuevo? 🙏` };
  }
}

/**
 * Genera contexto según el estado actual del usuario
 */
function getStateContext(state: string, userName: string): string {
  switch (state) {
    case "WAITING_STICKERS":
      return `El usuario "${userName}" está en proceso de decirnos qué láminas necesita. Está muy probable que esté enviando láminas. Si no entiendes qué láminas pide, pídele amablemente que las escriba con el formato: "colombia 12, mexico 6" o "COL12, MEX6".`;

    case "DONE":
      return `El usuario "${userName}" ya completó el registro. Puede estar:
1. Pidiendo más láminas (responde con JSON de códigos)
2. Preguntando algo sobre el servicio (responde naturalmente)
3. Saludando o conversando (sé amigable, recuérdale que puede pedir láminas o escribir "comprar")
4. Preguntando por precios ($1,500 COP por lámina)
5. Si dice "comprar", dile que escriba exactamente *comprar* para iniciar la compra`;

    default:
      return `El usuario "${userName}" está en estado: ${state}. Responde de forma amigable y guíalo en lo que necesite.`;
  }
}
