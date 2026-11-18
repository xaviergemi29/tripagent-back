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

/**
 * Precio pactado por lugar de una reserva (2026-11-17, decisión del usuario): `bookings.unitPrice`,
 * que se guarda al apartar. Respaldo para reservas anteriores sin el dato: total ÷ lugares apartados
 * y, sin token, el precio del tour. Las altas, bajas y lugares liberados usan este precio, nunca el
 * total ya ajustado (que puede incluir retenciones) dividido entre los pasajeros.
 */
export const resolveAgreedUnitPrice = (booking: {
  unitPrice?: number | string | null | undefined;
  totalPrice: number | string;
  numberPassengers?: number | null | undefined;
  tourPrice?: number | string | null | undefined;
}): number => {
  if (booking.unitPrice !== null && booking.unitPrice !== undefined)
    return Number(booking.unitPrice);
  if (booking.numberPassengers && booking.numberPassengers > 0) {
    return Math.round((Number(booking.totalPrice) / booking.numberPassengers) * 100) / 100;
  }
  return Number(booking.tourPrice) || 0;
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/**
 * Baja de un acompañante (FLUJO-RES-004 / PQ-C5; decisión del usuario, 2026-11-17). Única regla,
 * espejo en el front (`summarizeCompanionDrop`, vista previa del diálogo):
 * - nuevo total = total actual − precio pactado del lugar + retención para la agencia (nunca < 0);
 * - lo abonado (`amountPaid`, suma del libro) NO cambia;
 * - saldo por cobrar = nuevo total − abonado (si es positivo);
 * - saldo a devolver al titular = abonado − nuevo total (si es positivo). No se retiene en automático:
 *   el operador lo devuelve con un reembolso (`refundableSurplus`, regla 18 de `../CLAUDE.md`).
 * El tope de la retención (≤ precio del lugar) lo valida quien llama.
 */
export const summarizeCompanionDrop = (input: {
  currentTotal: number;
  unitPrice: number;
  penaltyAmount: number;
  amountPaid: number;
}) => {
  const newTotal = roundMoney(
    Math.max(0, input.currentTotal - input.unitPrice + input.penaltyAmount),
  );
  return {
    previousTotal: roundMoney(input.currentTotal),
    newTotal,
    unitPrice: roundMoney(input.unitPrice),
    penaltyAmount: roundMoney(input.penaltyAmount),
    nonRetainedAmount: roundMoney(Math.max(0, input.unitPrice - input.penaltyAmount)),
    pendingBalance: roundMoney(Math.max(0, newTotal - input.amountPaid)),
    refundableSurplus: roundMoney(Math.max(0, input.amountPaid - newTotal)),
    amountPaid: roundMoney(input.amountPaid),
  };
};

/**
 * Retenciones acumuladas por bajas de acompañantes en una reserva activa: lo que el total excede al
 * precio pactado × lugares apartados (los lugares sin registrar también se cobran a precio pactado,
 * así que se usan los lugares apartados y no solo los pasajeros activos).
 */
export const getRetainedPenaltyTotal = (input: {
  totalPrice: number;
  unitPrice: number;
  groupSize: number;
}): number => roundMoney(Math.max(0, input.totalPrice - input.unitPrice * input.groupSize));

/** Saldo a favor del titular en una reserva activa: lo abonado que excede al total. */
export const getRefundableSurplus = (input: { amountPaid: number; totalPrice: number }): number =>
  roundMoney(Math.max(0, input.amountPaid - input.totalPrice));
