import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { getEndOfMexicoDay } from "./mexico-date.util.js";
import { addDays } from "./tour-status.util.js";

/**
 * Enlace de staff (regla 26 de `../CLAUDE.md`, 2026-11-22): enlace público de solo lectura del
 * croquis y la lista de pasajeros para el coordinador del viaje, sin cuenta.
 *
 * Token: 24 bytes aleatorios de `crypto.randomBytes` en base64url → 32 caracteres `[A-Za-z0-9_-]`
 * (192 bits de entropía, más que los 122 de un UUID v4, y más corto que 48 caracteres hex). Es la
 * única credencial del enlace, así que no debe ser adivinable ni enumerable.
 */
const STAFF_SHARE_TOKEN_BYTES = 24;
export const STAFF_SHARE_TOKEN_LENGTH = 32;

/** Mensaje único de cualquier enlace no válido (inexistente, vencido, tour cancelado o borrado). */
export const STAFF_SHARE_UNAVAILABLE_MESSAGE = "Este enlace no está disponible";

/** Formato exacto del token: se valida antes de consultar la base. */
export const staffShareTokenSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${STAFF_SHARE_TOKEN_LENGTH}}$`));

export const generateStaffShareToken = (): string =>
  randomBytes(STAFF_SHARE_TOKEN_BYTES).toString("base64url");

/**
 * Vencimiento del enlace de staff: 24 h después de que termina el último día del tour en CDMX, es
 * decir, el final (23:59:59.999 CDMX) del día siguiente al último día. Último día = `returnDate` si
 * existe y no es anterior a la salida; si no, el día de salida (viaje de un día). Se calcula, no se
 * guarda: si el operador cambia las fechas del tour, el vencimiento se mueve con ellas.
 */
export const getStaffShareExpiresAt = (
  departureDate: string,
  returnDate: string | null | undefined,
): Date => {
  const lastDay = returnDate && returnDate >= departureDate ? returnDate : departureDate;
  return getEndOfMexicoDay(addDays(lastDay, 1));
};

export const isStaffShareExpired = (expiresAt: Date, now: Date = new Date()): boolean =>
  now.getTime() > expiresAt.getTime();

/** Resumen del enlace para el Centro de Control (`staffShare` del dashboard), o `null` sin token. */
export const describeStaffShare = (
  tour: { staffShareToken: string | null; departureDateTime: string; returnDate: string | null },
  now: Date = new Date(),
): { token: string; expiresAt: string; isExpired: boolean } | null => {
  if (!tour.staffShareToken) return null;
  const expiresAt = getStaffShareExpiresAt(tour.departureDateTime, tour.returnDate);
  return {
    token: tour.staffShareToken,
    expiresAt: expiresAt.toISOString(),
    isExpired: isStaffShareExpired(expiresAt, now),
  };
};

/**
 * Clave opaca de un pasajero dentro de un enlace de staff (pase de lista, RB-MAN-002): HMAC-SHA256
 * del id de la fila con el token como llave, en base64url (22 caracteres, 132 bits). No revela ids
 * internos (regla 26), solo sirve con ese enlace y deja de funcionar al regenerarlo.
 */
export const BOARDING_KEY_LENGTH = 22;
export const buildBoardingKey = (token: string, bookingPassengerId: string): string =>
  createHmac("sha256", token)
    .update(bookingPassengerId)
    .digest("base64url")
    .slice(0, BOARDING_KEY_LENGTH);

export const boardingKeySchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${BOARDING_KEY_LENGTH}}$`));
