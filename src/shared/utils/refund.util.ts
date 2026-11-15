/**
 * Reembolsos de una reserva (decisión del PM, 2026-11-14): única implementación del "saldo a
 * reembolsar" y del estado de la devolución. La usan el Centro de Control, el Magic Link y el
 * registro de pagos (tope del reembolso).
 *
 * El libro `payments` es de solo inserción: los abonos son positivos y los REFUND negativos. Un
 * REFUND puede ser una **anulación** (contra-asiento de un abono mal capturado, `voidPayment`, con
 * "(Ref: <uuid del abono>)" en `referenceInfo`) o una **devolución** real de dinero al cliente.
 */

/** Movimiento mínimo del libro de pagos que necesita el cálculo. */
export interface LedgerEntry {
  type: string;
  amount: number | string;
  referenceInfo?: string | null;
}

export type RefundStatus = "NONE" | "PENDING" | "COMPLETED";

export interface RefundSummary {
  /** Lo que el cliente abonó y sigue siendo válido (sin abonos anulados). */
  paidAmount: number;
  /** Lo que la agencia retiene: el total vigente de la reserva (penalización si se canceló). */
  retainedAmount: number;
  /** Devoluciones ya registradas (sin contar anulaciones). */
  refundedAmount: number;
  /** Lo que falta devolver: lo pagado neto menos lo retenido, nunca negativo. */
  refundableAmount: number;
  /** PENDING si falta devolver; COMPLETED si ya se devolvió todo; NONE si no hay nada que devolver. */
  refundStatus: RefundStatus;
}

const VOID_REFERENCE = /\(Ref: [0-9a-f-]{36}\)/i;

/** Contra-asiento de una anulación (`voidPayment`), no una devolución al cliente. */
export const isVoidEntry = (entry: LedgerEntry): boolean =>
  entry.type === "REFUND" && VOID_REFERENCE.test(entry.referenceInfo ?? "");

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Resume el dinero de una reserva para reembolsos.
 * - `amountPaid` es `bookings.amountPaid` (suma de todo el libro: abonos − anulaciones − devoluciones).
 * - `totalPrice` es `bookings.totalPrice`; en una reserva cancelada es la penalización retenida
 *   ($0 cuando cancela la agencia).
 */
export function summarizeRefunds(input: {
  amountPaid: number | string;
  totalPrice: number | string;
  payments: LedgerEntry[];
}): RefundSummary {
  const netPaid = Number(input.amountPaid) || 0;
  const retainedAmount = Math.max(0, Number(input.totalPrice) || 0);
  const refundedAmount = round2(
    input.payments
      .filter((entry) => entry.type === "REFUND" && !isVoidEntry(entry))
      .reduce((sum, entry) => sum + Math.abs(Number(entry.amount) || 0), 0),
  );
  const refundableAmount = round2(Math.max(0, netPaid - retainedAmount));

  return {
    paidAmount: round2(netPaid + refundedAmount),
    retainedAmount,
    refundedAmount,
    refundableAmount,
    refundStatus: refundableAmount > 0 ? "PENDING" : refundedAmount > 0 ? "COMPLETED" : "NONE",
  };
}
