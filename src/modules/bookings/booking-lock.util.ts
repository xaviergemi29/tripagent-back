import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";

/**
 * Bloquea la fila de la reserva (`SELECT … FOR UPDATE`) hasta el fin de la transacción y confirma
 * que pertenece a la agencia. Toda mutación que recalcula `amountPaid` (suma del libro de pagos) debe
 * llamarla PRIMERO: con READ COMMITTED, dos abonos o anulaciones simultáneos de la misma reserva
 * calculaban cada uno su SUMA sin ver el otro movimiento y el último en escribir dejaba un
 * `amountPaid` incompleto; también podían superar juntos el tope de reembolso o anular dos veces el
 * mismo abono. Con el candado se ejecutan uno tras otro y cada uno lee lo ya confirmado.
 */
export async function lockBookingForUpdate(
  tx: DbTransaction,
  bookingId: string,
  agencyId: string,
): Promise<void> {
  const [locked] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId), isNull(bookings.deletedAt)),
    )
    .for("update");
  if (!locked) throw new NotFoundError("Reserva no encontrada o no pertenece a esta agencia");
}
