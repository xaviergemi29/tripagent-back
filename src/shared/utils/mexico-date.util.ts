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

/** Mayoría de edad en México. */
export const ADULT_AGE = 18;

/**
 * ¿Quien nació en `birthDate` (`YYYY-MM-DD`) ya cumplió `years` años hoy en CDMX? Se compara como
 * texto el cumpleaños número `years` con hoy (un 29 de febrero se cumple el 1 de marzo).
 */
export const hasReachedAge = (
  birthDate: string,
  years: number,
  now: Date = new Date(),
): boolean => {
  const [year, rest] = [birthDate.slice(0, 4), birthDate.slice(4)];
  return `${Number(year) + years}${rest}` <= getTodayInMexico(now);
};

/**
 * ¿El pasajero es menor de edad? Marcado como Niño (`CHILD`) o, con fecha de nacimiento, menor de
 * 18 años hoy en CDMX. Activa el aviso del Art. 58, fracción X Ter, de la Ley General de Turismo.
 */
export const isMinorPassenger = (
  passenger: { passengerType?: string | null; birthDate?: string | null },
  now: Date = new Date(),
): boolean =>
  passenger.passengerType === "CHILD" ||
  (Boolean(passenger.birthDate) && !hasReachedAge(passenger.birthDate as string, ADULT_AGE, now));

/** El titular es el responsable financiero y acepta las políticas: nunca un menor (2026-11-23). */
export const MINOR_HOLDER_ERROR =
  "El titular de la reserva debe ser mayor de edad (18 años o más). Registra a un adulto como titular y al menor como acompañante.";

/** ¿La fecha `YYYY-MM-DD` es anterior a hoy en CDMX? */
export const isPastDate = (date: string, now: Date = new Date()): boolean =>
  date < getTodayInMexico(now);

/** Desfase de CDMX respecto a UTC en un instante, en milisegundos (p. ej. −6 h = −21 600 000). */
const getMexicoOffsetMs = (instant: Date): number => {
  const label =
    new Intl.DateTimeFormat("en-US", { timeZone: MX_TIME_ZONE, timeZoneName: "longOffset" })
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -1 : 1) * minutes * 60 * 1000;
};

/**
 * Último instante (23:59:59.999) del día `YYYY-MM-DD` en CDMX, como `Date` en UTC. Toma el desfase
 * de la zona horaria con `Intl` (no lo fija en −6 h), por si México vuelve a cambiar de horario.
 */
export const getEndOfMexicoDay = (date: string): Date => {
  const [year, month, day] = date.split("-").map(Number);
  // Medianoche del día siguiente "como si fuera UTC"; se corrige con el desfase de CDMX.
  const nextMidnightAsUtc = Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1);
  const offset = getMexicoOffsetMs(new Date(nextMidnightAsUtc));
  return new Date(nextMidnightAsUtc - offset - 1);
};

export const BIRTH_DATE_REQUIRED_ERROR = "La fecha de nacimiento es obligatoria";
export const FUTURE_BIRTH_DATE_ERROR = "La fecha de nacimiento no puede ser futura";
export const PAST_DEPARTURE_ERROR = "La fecha de salida no puede ser anterior a hoy";
