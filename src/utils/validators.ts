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

/**
 * Parsea códigos de láminas del formato: MEX6, FWC15, C7
 * También acepta: mex 6, fwc 15, c 7
 * Retorna códigos normalizados en mayúsculas: ["MEX6", "FWC15", "C7"]
 */
export function parseStickerCodes(text: string): string[] {
  const codes: string[] = [];

  // Separar por comas o saltos de línea
  const parts = text.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);

  for (const part of parts) {
    const normalized = part.toUpperCase().replace(/\s+/g, "");

    // Formato Coca-Cola: C1-C14
    const cocaMatch = normalized.match(/^C(\d{1,2})$/);
    if (cocaMatch) {
      const num = parseInt(cocaMatch[1]);
      if (num >= 1 && num <= 14) {
        codes.push(`C${num}`);
        continue;
      }
    }

    // Formato FIFA World Cup History: FWC9-FWC19
    const fwcMatch = normalized.match(/^FWC(\d{1,2})$/);
    if (fwcMatch) {
      const num = parseInt(fwcMatch[1]);
      if (num >= 9 && num <= 19) {
        codes.push(`FWC${num}`);
        continue;
      }
    }

    // Formato País: MEX6, ARG12, etc.
    const countryMatch = normalized.match(/^([A-Z]{2,3})(\d{1,2})$/);
    if (countryMatch) {
      const country = countryMatch[1];
      const num = parseInt(countryMatch[2]);
      if (COUNTRY_CODES.includes(country) && num >= 1 && num <= 20) {
        codes.push(`${country}${num}`);
        continue;
      }
    }
  }

  // Eliminar duplicados
  return [...new Set(codes)];
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
