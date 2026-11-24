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

// Código de un 409 que el cliente usa para decidir qué mostrar, nunca el texto del mensaje
// (folleto "Iniciar Reserva", 2026-11-18). Espejo en el front.
export const CONFLICT_CODES = ["CAPACITY_EXCEEDED", "BOOKINGS_CLOSED", "ALREADY_BOOKED"] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** Acceso por nombre: `new ConflictError(mensaje, CONFLICT_CODE.ALREADY_BOOKED)`. */
export const CONFLICT_CODE = {
  /** No alcanzan los lugares vendibles; la respuesta incluye `availableSeats`. */
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  /** El tour ya no recibe reservas en línea (ya salió o la agencia está en solo lectura). */
  BOOKINGS_CLOSED: "BOOKINGS_CLOSED",
  /** El WhatsApp ya tiene una reserva activa en el tour. */
  ALREADY_BOOKED: "ALREADY_BOOKED",
} as const satisfies Record<string, ConflictCode>;

// Tipo de notificación in-app (2026-11-22). Solo las generan acciones públicas del viajero: la
// pre-reserva del folleto y el registro del grupo en el Magic Link. Columna `notifications.type`.
export const NOTIFICATION_TYPES = ["PRE_BOOKING", "BOOKING_COMPLETED"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Acceso por nombre: `type: NOTIFICATION_TYPE.PRE_BOOKING`. */
export const NOTIFICATION_TYPE = {
  PRE_BOOKING: "PRE_BOOKING",
  BOOKING_COMPLETED: "BOOKING_COMPLETED",
} as const satisfies Record<NotificationType, NotificationType>;

// Tipo de habitación del hospedaje de un tour (regla 27). Enum de BD `lodging_room_type`. Espejo en
// el front. La capacidad por cuarto SIEMPRE sale de LODGING_ROOM_CAPACITY (nunca del cliente).
export const LODGING_ROOM_TYPES = [
  "MATRIMONIAL",
  "DOUBLE_INDIVIDUAL",
  "TRIPLE",
  "QUADRUPLE",
  // Al final: así la migración es un `ADD VALUE` simple (sin BEFORE).
  "SINGLE",
] as const;
export type LodgingRoomType = (typeof LODGING_ROOM_TYPES)[number];

/** Personas por habitación según su tipo (única regla). */
export const LODGING_ROOM_CAPACITY = {
  MATRIMONIAL: 2,
  DOUBLE_INDIVIDUAL: 2,
  TRIPLE: 3,
  QUADRUPLE: 4,
  SINGLE: 1,
} as const satisfies Record<LodgingRoomType, number>;

// Estado de una habitación con el hotel (regla 27). Enum de BD `lodging_room_status`. Espejo en el
// front. Toda habitación nace CONSULTED; el operador la marca CONFIRMED.
export const LODGING_ROOM_STATUSES = ["CONSULTED", "CONFIRMED"] as const;
export type LodgingRoomStatus = (typeof LODGING_ROOM_STATUSES)[number];
export const LODGING_ROOM_STATUS = {
  CONSULTED: "CONSULTED",
  CONFIRMED: "CONFIRMED",
} as const satisfies Record<LodgingRoomStatus, LodgingRoomStatus>;

/**
 * Motivos de baja de la suscripción (POST /agencies/subscription/cancel). Espejo en el front
 * (`SUBSCRIPTION_CANCELLATION_REASONS`, con sus etiquetas en español).
 */
export const SUBSCRIPTION_CANCELLATION_REASONS = [
  "LOW_SEASON",
  "PRICE",
  "MISSING_FEATURES",
  "OTHER",
] as const;
export type SubscriptionCancellationReason = (typeof SUBSCRIPTION_CANCELLATION_REASONS)[number];
