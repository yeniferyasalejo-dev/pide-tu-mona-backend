const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

export function parseStickerNumbers(text: string): number[] {
  const numbers = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => !isNaN(n) && Number.isInteger(n) && n > 0);

  // Eliminar duplicados
  return [...new Set(numbers)];
}
