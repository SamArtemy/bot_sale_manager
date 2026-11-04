const PHONE_RE = /^\+?[0-9][0-9 ()-]{8,19}$/;
const VIN_RE = /(?:^|[^A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?=$|[^A-Z0-9])/i;

export function cleanText(value?: string): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function validRequest(value: string): boolean {
  return value.length >= 3 && value.length <= 1000;
}

export function validVehicleInfo(value: string): boolean {
  return value.length <= 1000 && VIN_RE.test(value);
}

export function validName(value: string): boolean {
  return value.length >= 3 && value.length <= 150 && /\p{L}/u.test(value);
}

export function normalizePhone(raw: string): string | undefined {
  const value = cleanText(raw);
  if (!PHONE_RE.test(value)) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  return value.startsWith("+") ? `+${digits}` : digits;
}

export function validCity(value: string): boolean {
  return value.length >= 2 && value.length <= 100 && /\p{L}/u.test(value);
}
