import { TOUR_TEMPORAL_STATUS } from "../constants/domain.constants.js";
import { ConflictError } from "../errors/domain-errors.js";
import { getTourTemporalStatus } from "./tour-status.util.js";

/**
 * Modo Auditoría en la API (regla 9 de `../CLAUDE.md`, OBS-004; decisión del usuario, 2026-11-17):
 * un tour FINALIZADO o CANCELADO es de solo consulta. Toda mutación del operador sobre el tour, sus
 * reservas, sus pagos o sus asientos lo llama dentro de su transacción, antes de escribir, y responde
 * 409. EN CURSO sigue operable (cobros de último minuto y ajustes de asiento).
 *
 * Excepciones que NO lo llaman: registrar un REFUND en un tour CANCELADO (regla 18), cancelar el tour
 * (`cancelTour` tiene sus propias reglas) y darlo de baja (`softDeleteTour`, regla 15).
 */
export function assertTourNotInAuditMode(tour: {
  departureDateTime: string;
  returnDate: string | null;
  cancelledAt: string | null;
}): void {
  const status = getTourTemporalStatus(tour.departureDateTime, tour.cancelledAt, tour.returnDate);
  if (status === TOUR_TEMPORAL_STATUS.CANCELLED) {
    throw new ConflictError(
      "El tour fue cancelado por la agencia: está en modo de solo consulta y no admite cambios.",
    );
  }
  if (status === TOUR_TEMPORAL_STATUS.FINISHED) {
    throw new ConflictError(
      "El tour ya finalizó: está en modo de solo consulta y no admite cambios.",
    );
  }
}
