import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
import { isPhoneCountry, normalizePhone, phoneMatchesCountry } from "../utils/phone.util.js";

/**
 * Schemas de teléfono internacional (2026-11-16), espejo de
 * `tripagent-front/src/shared/schemas/phone.schema.ts`.
 *
 * Cada teléfono viaja con su país: `whatsappPhone` + `whatsappCountry`,
 * `emergencyContactPhone` + `emergencyContactCountry`, `phone` + `phoneCountry`, etc.
 * - El número llega en E.164 (front actual) o en 10 dígitos (clientes anteriores → México).
 * - El esquema lo devuelve **siempre** en E.164.
 * - El país es opcional por compatibilidad; si llega, su lada debe coincidir con el número
 *   (`refinePhoneCountry`, en el `superRefine` del objeto). Sin país, el número queda "sin confirmar".
 */

export const INVALID_PHONE_MESSAGE = "Número de teléfono inválido";

/** Teléfono obligatorio → E.164. */
export const phoneSchema = z
  .string()
  .trim()
  .max(30, INVALID_PHONE_MESSAGE)
  .transform((value, ctx) => {
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: INVALID_PHONE_MESSAGE });
      return z.NEVER;
    }
    return e164;
  });

/** Teléfono opcional → E.164; vacío, en blanco o nulo → `undefined`. */
export const optionalPhoneSchema = z.preprocess(
  (value) =>
    value === null || (typeof value === "string" && value.trim() === "") ? undefined : value,
  phoneSchema.optional(),
);

/** País del teléfono (ISO 3166-1 alfa-2). Vacío o nulo → `null` (sin confirmar). */
export const phoneCountrySchema = z
  .union([z.string().trim().toUpperCase(), z.null()])
  .optional()
  .transform((value, ctx): CountryCode | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (!isPhoneCountry(value)) {
      ctx.addIssue({ code: "custom", message: "País del teléfono inválido" });
      return z.NEVER;
    }
    return value;
  });

/**
 * Valida que el país coincida con la lada del número (dentro de un `superRefine` de objeto, cuando
 * los campos ya se transformaron). Sin número o sin país no hay nada que comparar.
 */
export function refinePhoneCountry(
  ctx: z.RefinementCtx,
  phone: string | null | undefined,
  country: CountryCode | null | undefined,
  path: string,
): void {
  if (!phone || !country) return;
  if (!phoneMatchesCountry(phone, country)) {
    ctx.addIssue({
      code: "custom",
      path: [path],
      message: "El número no corresponde a la lada del país seleccionado",
    });
  }
}
