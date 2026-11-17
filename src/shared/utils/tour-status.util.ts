import { TOUR_TEMPORAL_STATUS, type TourTemporalStatus } from "../constants/domain.constants.js";

/** Suma días a una fecha `YYYY-MM-DD` (mediodía UTC para no cruzar de día por la zona horaria). */
const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().split("T")[0] ?? date;
};

/**
 * Último día en que el tour está EN CURSO (`YYYY-MM-DD`):
 * - con fecha de regreso válida (≥ salida) → el día de regreso;
 * - sin fecha de regreso → el día siguiente a la salida (tolerancia de un día).
 * Antes del 2026-11-15 se ignoraba el regreso: un tour de un día seguía EN CURSO al día siguiente
 * y uno de varios días pasaba a FINALIZADO a mitad del viaje.
 */
export const getTourLastActiveDate = (
  departureDate: string,
  returnDate: string | null | undefined,
): string => (returnDate && returnDate >= departureDate ? returnDate : addDays(departureDate, 1));

/**
 * Calcula el estado temporal de un tour con su salida, su regreso y su cancelación.
 * Utiliza la zona horaria de México (America/Mexico_City) como ancla de la verdad.
 * CANCELADO = la agencia canceló el tour (`tours.cancelledAt`); ya no depende de `isActive`
 * ("Pausado" no existe en el MVP, decisión del PM 2026-11-14).
 */
export const getTourTemporalStatus = (
  departureDate: string,
  cancelledAt: string | null | undefined,
  returnDate?: string | null,
  now: Date = new Date(),
): TourTemporalStatus => {
  // Regla 1: Cancelación por la agencia (definitiva)
  if (cancelledAt) return TOUR_TEMPORAL_STATUS.CANCELLED;

  // Validamos que departureDate exista antes de operar
  if (!departureDate) return TOUR_TEMPORAL_STATUS.UPCOMING;

  // Fecha actual en México (YYYY-MM-DD)
  const todayMX = now.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

  // Regla 2: Evaluaciones temporales
  if (todayMX < departureDate) return TOUR_TEMPORAL_STATUS.UPCOMING;
  if (todayMX <= getTourLastActiveDate(departureDate, returnDate)) {
    return TOUR_TEMPORAL_STATUS.IN_PROGRESS;
  }
  return TOUR_TEMPORAL_STATUS.FINISHED;
};
