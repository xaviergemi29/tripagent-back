import { TOUR_TEMPORAL_STATUS, type TourTemporalStatus } from "../constants/domain.constants.js";

/**
 * Calcula el estado temporal de un tour basado en su fecha de salida y su cancelación.
 * Utiliza la zona horaria de México (America/Mexico_City) como ancla de la verdad.
 * CANCELADO = la agencia canceló el tour (`tours.cancelledAt`); ya no depende de `isActive`
 * ("Pausado" no existe en el MVP, decisión del PM 2026-11-14).
 */
export const getTourTemporalStatus = (
  departureDate: string,
  cancelledAt: string | null | undefined,
): TourTemporalStatus => {
  // Regla 1: Cancelación por la agencia (definitiva)
  if (cancelledAt) return TOUR_TEMPORAL_STATUS.CANCELLED;

  // Extraemos la fecha actual exacta en México (YYYY-MM-DD)
  const todayMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

  // Validamos que departureDate exista antes de operar
  if (!departureDate) return TOUR_TEMPORAL_STATUS.UPCOMING;

  // Matemática de fechas segura tipada explícitamente
  const tourDate = new Date(`${departureDate}T12:00:00Z`);
  tourDate.setDate(tourDate.getDate() + 1); // +24 horas (1 día de tolerancia)

  // Aseguramos que el resultado no sea undefined usando un fallback o conversión segura
  const toleranceDate: string = tourDate.toISOString().split("T")[0] ?? departureDate;

  // Regla 2: Evaluaciones temporales
  if (todayMX < departureDate) return TOUR_TEMPORAL_STATUS.UPCOMING;
  if (todayMX >= departureDate && todayMX <= toleranceDate) return TOUR_TEMPORAL_STATUS.IN_PROGRESS;
  return TOUR_TEMPORAL_STATUS.FINISHED;
};
