import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

/**
 * Teléfonos internacionales (2026-11-16). Única implementación del backend: el front usa la misma
 * librería (`libphonenumber-js`, metadatos "min") en `src/shared/utils/phone.util.ts`.
 *
 * Modelo:
 * - El número se guarda en **E.164** (`+522281234567`) en la columna de siempre
 *   (`travelers.whatsapp_phone`, `travelers.emergency_contact_phone`, `agencies.phone`).
 * - El **país del número** (ISO 3166-1 alfa-2: `MX`, `US`, `CA`…) va en su columna `*_country`.
 *   Distingue países que comparten lada (+1 = EE. UU., Canadá…). `null` = lada inferida y sin
 *   confirmar (registros anteriores a esta funcionalidad).
 * - La lada y el número nacional no se guardan: se calculan desde el E.164.
 *
 * Compatibilidad: antes solo se capturaban 10 dígitos (México) y algunos registros pueden seguir
 * así hasta correr `npm run phones:normalize`. Un número sin "+" y sin país se interpreta como
 * mexicano, que es lo que el sistema siempre hizo al armar los enlaces `wa.me`.
 */

/** País que se asume para los números capturados antes de existir el selector de lada. */
export const LEGACY_PHONE_COUNTRY: CountryCode = "MX";

/** `true` si es un código ISO alfa-2 que la librería conoce (y por lo tanto tiene lada). */
export const isPhoneCountry = (value: string): value is CountryCode => isSupportedCountry(value);

/**
 * Normaliza un teléfono a E.164 o devuelve `null` si no es válido.
 * - Con "+" (o "00"): número internacional; si llega `country`, su lada debe coincidir.
 * - Sin "+" y con `country`: número nacional de ese país.
 * - Sin "+" y sin `country` (clientes y datos anteriores): primero como número mexicano y, si no
 *   lo es, como internacional sin el "+" (p. ej. `522281234567` guardado en una agencia).
 */
export function normalizePhone(raw: string, country?: CountryCode | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  const isInternational = trimmed.startsWith("+") || trimmed.startsWith("00");
  if (isInternational) {
    const international = digits.startsWith("00") ? digits.slice(2) : digits;
    const parsed = parsePhoneNumberFromString(`+${international}`);
    if (parsed?.isValid()) {
      if (country && parsed.countryCallingCode !== getCountryCallingCode(country)) return null;
      return parsed.number;
    }
    // Formato anterior del apartado rápido: "+" seguido de los 10 dígitos nacionales.
    if (!country && digits.length === 10) return toValidE164(digits, LEGACY_PHONE_COUNTRY);
    return null;
  }

  if (country) return toValidE164(digits, country);
  const asMexican = toValidE164(digits, LEGACY_PHONE_COUNTRY);
  if (asMexican) return asMexican;
  const asInternational = parsePhoneNumberFromString(`+${digits}`);
  return asInternational?.isValid() ? asInternational.number : null;
}

function toValidE164(nationalDigits: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(nationalDigits, country);
  return parsed?.isValid() ? parsed.number : null;
}

/** `true` si la lada del número E.164 corresponde al país indicado. */
export function phoneMatchesCountry(e164: string, country: CountryCode): boolean {
  return parsePhoneNumberFromString(e164)?.countryCallingCode === getCountryCallingCode(country);
}

/**
 * Valores con los que puede estar guardado un mismo número mientras conviven los formatos: el E.164
 * y, si es mexicano, los formatos anteriores (`2281234567` y `+2281234567`). Se usan en las
 * búsquedas por WhatsApp para no crear un viajero duplicado. Tras `phones:normalize` sobran, pero
 * no estorban.
 */
export function phoneLookupCandidates(e164: string): string[] {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || parsed.countryCallingCode !== getCountryCallingCode(LEGACY_PHONE_COUNTRY)) {
    return [e164];
  }
  const national = parsed.nationalNumber;
  return [e164, national, `+${national}`];
}

/**
 * Compara dos teléfonos guardados o capturados en cualquiera de los formatos (E.164 o los 10
 * dígitos anteriores). Dos vacíos son iguales.
 */
export function isSamePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a ? (normalizePhone(a) ?? a.trim()) : null;
  const right = b ? (normalizePhone(b) ?? b.trim()) : null;
  return left === right;
}
