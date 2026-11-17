/**
 * Fechas calendario en la hora de CDMX (zona de referencia del producto). Las fechas sin hora
 * (`YYYY-MM-DD`) se comparan como texto: el formato ISO ordena igual que el calendario.
 */
const MX_TIME_ZONE = "America/Mexico_City";

/** Hoy en CDMX (`YYYY-MM-DD`). */
export const getTodayInMexico = (now: Date = new Date()): string =>
  now.toLocaleDateString("en-CA", { timeZone: MX_TIME_ZONE });

/** ¿La fecha `YYYY-MM-DD` es posterior a hoy en CDMX? */
export const isFutureDate = (date: string, now: Date = new Date()): boolean =>
  date > getTodayInMexico(now);

/** ¿La fecha `YYYY-MM-DD` es anterior a hoy en CDMX? */
export const isPastDate = (date: string, now: Date = new Date()): boolean =>
  date < getTodayInMexico(now);

export const BIRTH_DATE_REQUIRED_ERROR = "La fecha de nacimiento es obligatoria";
export const FUTURE_BIRTH_DATE_ERROR = "La fecha de nacimiento no puede ser futura";
export const PAST_DEPARTURE_ERROR = "La fecha de salida no puede ser anterior a hoy";
