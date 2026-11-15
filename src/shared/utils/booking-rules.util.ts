import type { BOOKING_STATUS } from "../../db/schema.js";

export type BookingStatus = (typeof BOOKING_STATUS.enumValues)[number];

/**
 * Tamaño esperado del grupo de una reserva.
 * Prioridad 1: lugares apartados en el Magic Token. Prioridad 2 (reservas sin token):
 * heurística total / precio unitario del tour.
 */
export const getExpectedGroupSize = (
  numberPassengers: number | null | undefined,
  totalPrice: number,
  tourPrice: number,
): number =>
  numberPassengers ? numberPassengers : Math.max(1, Math.round(totalPrice / (tourPrice || 1)));

/** "Anticipo a pagar" de la reserva: anticipo por persona del tour × lugares apartados. */
export const getRequiredDeposit = (depositPerPerson: number, groupSize: number): number =>
  Number(depositPerPerson || 0) * groupSize;

/**
 * Regla del PM (2026-11-11): el grupo cubre la cuota mínima cuando lo pagado iguala o supera
 * el anticipo requerido. Con anticipo $0 la condición se cumple sin pagos (regla literal).
 * Da derecho a elegir asiento y es condición para confirmar la reserva.
 */
export const isDepositCovered = (amountPaid: number, requiredDeposit: number): boolean =>
  Number(amountPaid || 0) >= requiredDeposit;

export interface BookingStatusInput {
  currentStatus: BookingStatus;
  totalPaid: number;
  requiredDeposit: number;
  isFormComplete: boolean;
}

/**
 * Máquina de estados DERIVADA de la reserva (regla 11 de CLAUDE.md). Función pura:
 * - CANCELLED y NO_SHOW son terminales.
 * - Formulario sin llenar → AWAITING_REGISTRATION.
 * - Formulario lleno + anticipo cubierto → CONFIRMED; si no → PENDING (puede revertir).
 */
export const calculateBookingStatus = ({
  currentStatus,
  totalPaid,
  requiredDeposit,
  isFormComplete,
}: BookingStatusInput): BookingStatus => {
  if (currentStatus === "CANCELLED" || currentStatus === "NO_SHOW") return currentStatus;
  if (!isFormComplete) return "AWAITING_REGISTRATION";
  return isDepositCovered(totalPaid, requiredDeposit) ? "CONFIRMED" : "PENDING";
};

/** Capacidad vendible del tour: capacidad total menos lugares de staff (regla 12). */
export const getSellableCapacity = (maxCapacity: number, staffCapacity: number): number =>
  Math.max(0, Number(maxCapacity || 0) - Number(staffCapacity || 0));

export interface OccupancyBookingRow {
  totalPrice: number;
  numberPassengers: number | null | undefined;
}

/**
 * Lugares ocupados = suma del tamaño de grupo de las reservas recibidas.
 * Quien llama es responsable de pasar solo reservas no canceladas ni borradas.
 */
export const sumOccupiedSeats = (rows: OccupancyBookingRow[], tourPrice: number): number =>
  rows.reduce(
    (total, row) =>
      total + getExpectedGroupSize(row.numberPassengers, Number(row.totalPrice), tourPrice),
    0,
  );
