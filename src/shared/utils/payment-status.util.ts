import type { PAYMENT_STATUS } from "../../db/schema.js";
import { isVoidEntry, type LedgerEntry } from "./refund.util.js";

export type PaymentStatus = (typeof PAYMENT_STATUS.enumValues)[number];

/** Tolerancia de medio centavo para comparar importes `numeric` convertidos a número. */
const CENT_TOLERANCE = 0.005;

/**
 * Estado de pago de una reserva: ÚNICA regla (autorizada por el usuario el 2026-11-17; antes se
 * calculaba distinto en abono, anulación, cancelación total, baja de acompañante, agregar lugar y
 * liberar lugar, p. ej. total $0 sin dinero daba PAID en la anulación y PENDING en otros flujos).
 * - Sin dinero neto (≤ $0): REFUNDED si hubo una devolución real al cliente; si no, PENDING.
 * - Lo pagado cubre el total: PAID (también con saldo a favor, p. ej. cancelada con retención
 *   menor a lo abonado).
 * - Si no: PARTIAL.
 * El estado de la reserva (CONFIRMED, PENDING…) es otra regla: `calculateBookingStatus`.
 */
export function derivePaymentStatus(input: {
  amountPaid: number | string;
  totalPrice: number | string;
  /** Hay al menos una devolución real (REFUND que no es anulación) en el libro de pagos. */
  hasRefund?: boolean;
}): PaymentStatus {
  const paid = Number(input.amountPaid) || 0;
  const total = Number(input.totalPrice) || 0;

  if (paid <= CENT_TOLERANCE) return input.hasRefund ? "REFUNDED" : "PENDING";
  if (paid + CENT_TOLERANCE >= total) return "PAID";
  return "PARTIAL";
}

/** ¿El libro de pagos tiene una devolución real al cliente (no una anulación)? */
export const ledgerHasRefund = (entries: LedgerEntry[]): boolean =>
  entries.some((entry) => entry.type === "REFUND" && !isVoidEntry(entry));
