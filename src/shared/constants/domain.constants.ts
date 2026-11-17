/**
 * Enums de dominio que NO son enums de base de datos (esos viven en `src/db/schema.ts` como
 * `pgEnum`). Son parte del contrato de la API y los usan varios módulos.
 * Espejo en el front: `tripagent-front/src/shared/constants/domain.constants.ts`.
 */

// Rol de un pasajero dentro de su reserva. En BD es el booleano `booking_passengers.isTitular`;
// la API lo expone como rol en el Centro de Control y en la transferencia de viajero.
export const PASSENGER_ROLES = ["TITULAR", "COMPANION"] as const;
export type PassengerRole = (typeof PASSENGER_ROLES)[number];

/** Acceso por nombre para comparar sin escribir el texto: `role === PASSENGER_ROLE.TITULAR`. */
export const PASSENGER_ROLE = {
  TITULAR: "TITULAR",
  COMPANION: "COMPANION",
} as const satisfies Record<PassengerRole, PassengerRole>;

// Estado temporal del tour (regla 9 de CLAUDE.md): lo calcula `getTourTemporalStatus` con la hora
// de CDMX y viaja como `temporalStatus` en el listado de tours y el dashboard. Ojo: "EN CURSO" lleva
// espacio, no guion bajo.
export const TOUR_TEMPORAL_STATUSES = ["PRÓXIMO", "EN CURSO", "FINALIZADO", "CANCELADO"] as const;
export type TourTemporalStatus = (typeof TOUR_TEMPORAL_STATUSES)[number];

/** Acceso por nombre: `status === TOUR_TEMPORAL_STATUS.IN_PROGRESS`. */
export const TOUR_TEMPORAL_STATUS = {
  UPCOMING: "PRÓXIMO",
  IN_PROGRESS: "EN CURSO",
  FINISHED: "FINALIZADO",
  CANCELLED: "CANCELADO",
} as const satisfies Record<string, TourTemporalStatus>;

// Motivo de cancelación de un tour por la agencia (decisión del PM, 2026-11-14): lista fija para que
// el mensaje al viajero sea consistente. Se guarda el código en `tours.cancellationReason`.
// Etiquetas en el front: TOUR_CANCELLATION_REASON_DICT.
export const TOUR_CANCELLATION_REASONS = ["WEATHER", "SECURITY", "LOW_SALES", "OTHER"] as const;

/** Máximo de la nota interna de cancelación. */
export const TOUR_CANCELLATION_NOTE_MAX_LENGTH = 200;
