import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import {
  calculateBookingStatus,
  getExpectedGroupSize,
  getRequiredDeposit,
} from "../../shared/utils/booking-rules.util.js";

/**
 * Aplica la máquina de estados derivada (calculateBookingStatus) a una reserva persistida.
 * Se inyecta al final de TODA mutación financiera o de grupo: pagos, anulaciones, registro,
 * altas y bajas de lugares o pasajeros.
 */
export class BookingStatusService {
  /**
   * Debe llamarse dentro de la transacción y DESPUÉS de actualizar amountPaid, totalPrice o el
   * tamaño del grupo, para que lea los valores ya modificados.
   * @param options.formCompleted  true cuando la mutación es el registro del formulario.
   */
  static async syncStatus(
    tx: DbTransaction,
    bookingId: string,
    options: { formCompleted?: boolean } = {},
  ) {
    const booking = await tx.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      columns: { status: true, amountPaid: true, totalPrice: true },
      with: {
        tour: { columns: { price: true, depositPerPerson: true } },
        magicToken: { columns: { numberPassengers: true } },
      },
    });
    if (!booking) return;

    const groupSize = getExpectedGroupSize(
      booking.magicToken?.numberPassengers,
      Number(booking.totalPrice),
      Number(booking.tour.price),
    );
    const newStatus = calculateBookingStatus({
      currentStatus: booking.status,
      totalPaid: Number(booking.amountPaid),
      requiredDeposit: getRequiredDeposit(Number(booking.tour.depositPerPerson), groupSize),
      isFormComplete: options.formCompleted === true || booking.status !== "AWAITING_REGISTRATION",
    });

    if (newStatus !== booking.status) {
      await tx
        .update(bookings)
        .set({ status: newStatus, updatedAt: new Date().toISOString() })
        .where(eq(bookings.id, bookingId));
    }
  }
}
