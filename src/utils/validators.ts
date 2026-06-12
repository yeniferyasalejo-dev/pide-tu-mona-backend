// Precios en COP — cambiar aquí actualiza todo el sistema
export const STICKER_PRICE = 1500;
export const STICKER_PRICE_FORMATTED = new Intl.NumberFormat("es-CO").format(STICKER_PRICE);
export const DELIVERY_FEE = 5000;
export const DELIVERY_FEE_FORMATTED = new Intl.NumberFormat("es-CO").format(DELIVERY_FEE);
export const PSE_FEE = 500;
export const PSE_FEE_FORMATTED = new Intl.NumberFormat("es-CO").format(PSE_FEE);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

// Países válidos del álbum Mundial 2026
export const VALID_COUNTRIES: Record<string, string> = {
  MEX: "MEXICO",
  RSA: "SUR AFRICA",
  KOR: "COREA SUR",
  CZE: "REP. CHECA",
  CAN: "CANADA",
  BIH: "BOSNIA",
  QAT: "CATAR",
  SUI: "SUIZA",
  BRA: "BRASIL",
  MAR: "MARRUECOS",
  HAI: "HAITI",
  SCO: "ESCOCIA",
  USA: "EE.UU",
  PAR: "PARAGUAY",
  AUS: "AUSTRALIA",
  TUR: "TURQUIA",
  GER: "ALEMANIA",
  CUW: "CURAZAO",
  CIV: "COSTA DE MARFIL",
  ECU: "ECUADOR",
  NED: "HOLANDA",
  JPN: "JAPON",
  SWE: "SUECIA",
  TUN: "TUNEZ",
  BEL: "BELGICA",
  EGY: "EGIPTO",
  IRN: "IRAN",
  NZL: "NUEVA ZELANDA",
  ESP: "ESPAÑA",
  CPV: "CABO VERDE",
  KSA: "ARABIA SAUDI",
  URU: "URUGUAY",
  FRA: "FRANCIA",
  SEN: "SENEGAL",
  IRQ: "IRAK",
  NOR: "NORUEGA",
  ARG: "ARGENTINA",
  ALG: "ARGELIA",
  AUT: "AUSTRIA",
  JOR: "JORDANIA",
  POR: "PORTUGAL",
  COD: "CONGO",
  UZB: "UZBEQUISTAN",
  COL: "COLOMBIA",
  ENG: "INGLATERRA",
  CRO: "CROACIA",
  GHA: "GHANA",
  PAN: "PANAMA",
};

const COUNTRY_CODES = Object.keys(VALID_COUNTRIES);

// Mapa inverso: nombre del país → código (para buscar por nombre completo)
const NAME_TO_CODE: Record<string, string> = {};
for (const [code, name] of Object.entries(VALID_COUNTRIES)) {
  NAME_TO_CODE[name.toUpperCase()] = code;
  // También sin tildes/variantes comunes
  NAME_TO_CODE[name.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")] = code;
}
// Aliases adicionales comunes
NAME_TO_CODE["ESTADOS UNIDOS"] = "USA";
NAME_TO_CODE["EEUU"] = "USA";
NAME_TO_CODE["COREA"] = "KOR";
NAME_TO_CODE["REPUBLICA CHECA"] = "CZE";
NAME_TO_CODE["REP CHECA"] = "CZE";
NAME_TO_CODE["ARABIA"] = "KSA";
NAME_TO_CODE["COSTA DE MARFIL"] = "CIV";
NAME_TO_CODE["NUEVA ZELANDA"] = "NZL";
NAME_TO_CODE["CABO VERDE"] = "CPV";
NAME_TO_CODE["COCACOLA"] = "COCA";
NAME_TO_CODE["COCA COLA"] = "COCA";
NAME_TO_CODE["COCA-COLA"] = "COCA";
NAME_TO_CODE["FIFA"] = "FWC";
NAME_TO_CODE["WORLD CUP"] = "FWC";
NAME_TO_CODE["FWC"] = "FWC";

/**
 * Busca el código de país a partir del nombre completo
 */
function findCountryCode(name: string): string | null {
  const upper = name.toUpperCase().trim();
  // Buscar directo
  if (COUNTRY_CODES.includes(upper)) return upper;
  // Buscar por nombre
  if (NAME_TO_CODE[upper]) return NAME_TO_CODE[upper];
  // Buscar parcial (ej: "sur africa" → "SUR AFRICA")
  for (const [fullName, code] of Object.entries(NAME_TO_CODE)) {
    if (fullName.includes(upper) || upper.includes(fullName)) return code;
  }
  return null;
}

/**
 * Parsea códigos de láminas. Acepta múltiples formatos:
 * - Código + número: MEX6, ARG12, FWC15, C7
 * - Código espacio número: MEX 6, ARG 12
 * - Nombre completo + número: Colombia 12, Brasil 5, Mexico 10
 * - Coca-Cola: C7, coca cola 7, cocacola 7
 * - FIFA: FWC15, fifa 15
 */
export function parseStickerCodes(text: string): string[] {
  const codes: string[] = [];
  const upper = text.toUpperCase().trim();

  // Detectar rangos: "país X a Y", "país X al Y", "país de la X a la Y", "país X-Y"
  const rangePatterns = [
    /(.+?)\s+(?:DE\s+(?:LA\s+)?)?(\d{1,2})\s+(?:A(?:L)?(?:\s+LA)?)\s+(\d{1,2})/gi,
    /(.+?)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/gi,
  ];

  let hasRange = false;
  for (const pattern of rangePatterns) {
    let match;
    while ((match = pattern.exec(upper)) !== null) {
      const nameOrCode = match[1].replace(/^.*?(LAS\s+DE|LOS\s+DE|DE)\s+/i, "").trim();
      const from = parseInt(match[2]);
      const to = parseInt(match[3]);
      const resolvedCode = findCountryCode(nameOrCode);

      if (resolvedCode && from <= to) {
        hasRange = true;
        if (resolvedCode === "COCA") {
          for (let i = Math.max(from, 1); i <= Math.min(to, 14); i++) codes.push(`C${i}`);
        } else if (resolvedCode === "FWC") {
          for (let i = Math.max(from, 9); i <= Math.min(to, 19); i++) codes.push(`FWC${i}`);
        } else if (COUNTRY_CODES.includes(resolvedCode)) {
          for (let i = Math.max(from, 1); i <= Math.min(to, 20); i++) codes.push(`${resolvedCode}${i}`);
        }
      }
    }
  }

  if (hasRange) return [...new Set(codes)];

  // Separar por comas o saltos de línea
  const parts = text.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);

  for (const part of parts) {
    const partUpper = part.toUpperCase().trim();
    const noSpaces = partUpper.replace(/\s+/g, "");

    // Coca-Cola: C1-C14
    const cocaMatch = noSpaces.match(/^C(\d{1,2})$/);
    if (cocaMatch) {
      const num = parseInt(cocaMatch[1]);
      if (num >= 1 && num <= 14) { codes.push(`C${num}`); continue; }
    }

    // FIFA World Cup History: FWC9-FWC19
    const fwcMatch = noSpaces.match(/^FWC(\d{1,2})$/);
    if (fwcMatch) {
      const num = parseInt(fwcMatch[1]);
      if (num >= 9 && num <= 19) { codes.push(`FWC${num}`); continue; }
    }

    // Código de país pegado: MEX6, ARG12
    const codeMatch = noSpaces.match(/^([A-Z]{2,3})(\d{1,2})$/);
    if (codeMatch) {
      const country = codeMatch[1];
      const num = parseInt(codeMatch[2]);
      if (COUNTRY_CODES.includes(country) && num >= 1 && num <= 20) { codes.push(`${country}${num}`); continue; }
    }

    // Formato con espacio: "Colombia 12", "Brasil 5"
    const spaceMatch = partUpper.match(/^(.+?)\s+(\d{1,2})$/);
    if (spaceMatch) {
      const nameOrCode = spaceMatch[1].trim();
      const num = parseInt(spaceMatch[2]);
      const resolvedCode = findCountryCode(nameOrCode);

      if (resolvedCode === "COCA" && num >= 1 && num <= 14) { codes.push(`C${num}`); continue; }
      if (resolvedCode === "FWC" && num >= 9 && num <= 19) { codes.push(`FWC${num}`); continue; }
      if (resolvedCode && COUNTRY_CODES.includes(resolvedCode) && num >= 1 && num <= 20) { codes.push(`${resolvedCode}${num}`); continue; }
    }
  }

  return [...new Set(codes)];
}

/**
 * Detecta si el usuario escribió láminas con números fuera de rango
 * y devuelve un mensaje de error útil. Retorna null si no detecta el problema.
 */
export function detectOutOfRange(text: string): string | null {
  const parts = text.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);

  for (const part of parts) {
    const upper = part.toUpperCase().trim();
    const noSpaces = upper.replace(/\s+/g, "");

    // Código pegado: COL54
    const codeMatch = noSpaces.match(/^([A-Z]{2,3})(\d{1,3})$/);
    if (codeMatch) {
      const country = codeMatch[1];
      const num = parseInt(codeMatch[2]);
      if (COUNTRY_CODES.includes(country) && num > 20) {
        const countryName = VALID_COUNTRIES[country] || country;
        return `La lámina *${country}${num}* no existe 🤔\n\n*${countryName}* solo tiene láminas del *1 al 20*.\n\nEjemplo: \`${country}1, ${country}12, ${country}20\``;
      }
    }

    // Con espacio: "colombia 54"
    const spaceMatch = upper.match(/^(.+?)\s+(\d{1,3})$/);
    if (spaceMatch) {
      const nameOrCode = spaceMatch[1].trim();
      const num = parseInt(spaceMatch[2]);
      const resolvedCode = findCountryCode(nameOrCode);

      if (resolvedCode === "COCA" && num > 14) {
        return `La lámina *C${num}* no existe 🤔\n\n*Coca-Cola* solo tiene láminas del *1 al 14*.\n\nEjemplo: \`C1, C7, C14\``;
      }
      if (resolvedCode === "FWC" && (num < 9 || num > 19)) {
        return `La lámina *FWC${num}* no existe 🤔\n\n*FIFA World Cup History* solo tiene láminas del *9 al 19*.\n\nEjemplo: \`FWC9, FWC15, FWC19\``;
      }
      if (resolvedCode && COUNTRY_CODES.includes(resolvedCode) && num > 20) {
        const countryName = VALID_COUNTRIES[resolvedCode] || resolvedCode;
        return `La lámina *${resolvedCode}${num}* no existe 🤔\n\n*${countryName}* solo tiene láminas del *1 al 20*.\n\nEjemplo: \`${resolvedCode}1, ${resolvedCode}12, ${resolvedCode}20\``;
      }
    }
  }

  return null;
}

/**
 * Genera la lista de todos los códigos válidos de láminas
 */
export function getAllValidCodes(): string[] {
  const codes: string[] = [];

  // Países: 1-20 cada uno
  for (const country of COUNTRY_CODES) {
    for (let i = 1; i <= 20; i++) {
      codes.push(`${country}${i}`);
    }
  }

  // FIFA World Cup History: 9-19
  for (let i = 9; i <= 19; i++) {
    codes.push(`FWC${i}`);
  }

  // Coca-Cola: C1-C14
  for (let i = 1; i <= 14; i++) {
    codes.push(`C${i}`);
  }

  return codes;
}
