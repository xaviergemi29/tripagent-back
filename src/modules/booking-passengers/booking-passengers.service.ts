import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { BookingService } from "../bookings/booking.service.js";
import { bookings, bookingPassengers, PAYMENT_STATUS, magicTokens } from "../../db/schema.js";

export class BookingPassengerService {
  static async cancelPassenger(
    bookingId: string,
    travelerId: string,
    penaltyAmount: number,
    agencyId: string,
  ) {
    return await db.transaction(async (tx) => {
      // 1. Validar la reserva maestra
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada");
      if (booking.status === "CANCELLED")
        throw new Error("La reserva ya está cancelada por completo");

      // 2. Verificar pasajero ACTIVO
      const targetPassenger = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, travelerId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      if (!targetPassenger) {
        throw new Error("El pasajero no existe o ya fue cancelado");
      }

      // 3. Obtener el grupo activo para las matemáticas
      const activePassengers = await tx.query.bookingPassengers.findMany({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      const activeCount = activePassengers.length;
      if (activeCount <= 1) {
        throw new Error("Es el último pasajero activo. Usa la función de Cancelación Total.");
      }

      // 4. Matemáticas Financieras: El descuento
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);
      // Valor actual y exacto de un asiento individual en este grupo antes de la baja
      const unitPrice = currentTotalPrice / activeCount;

      // 🛡️ Validación Defensiva: No puedes penalizar por un monto mayor a lo que cuesta el boleto
      if (penaltyAmount > unitPrice) {
        throw new Error(
          `La penalización ($${penaltyAmount}) no puede superar el costo individual del asiento ($${unitPrice}).`,
        );
      }
      // ¿Cuánto le vamos a descontar a la deuda total?
      // Si el asiento cuesta 500 y penalizamos 200, solo le restamos 300 a la deuda del grupo.
      const deduction = unitPrice - penaltyAmount;
      const newTotalPrice = Math.max(0, currentTotalPrice - deduction);

      // 5. Bajar al pasajero del camión (Soft Delete lógico)
      await tx
        .update(bookingPassengers)
        .set({ status: "CANCELLED", seatLabel: null })
        .where(eq(bookingPassengers.id, targetPassenger.id));

      // 6. Máquina de Estados Financiera
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = booking.paymentStatus;

      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      } else if (newTotalPrice === 0) {
        newPaymentStatus = "PAID";
      }

      // 7. Actualizar la Reserva Maestra
      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      await tx
        .update(magicTokens)
        .set({
          numberPassengers: sql`${magicTokens.numberPassengers} - 1`,
        })
        .where(eq(magicTokens.bookingId, bookingId));

      // Grupo más chico = menor anticipo requerido: el estado PENDING ⇄ CONFIRMED se recalcula.
      await BookingService.syncConfirmationStatus(tx, bookingId);

      // 8. Handoff para el Frontend (UX)
      const isOverpaid = amountPaid > newTotalPrice;
      const surplusAmount = isOverpaid ? amountPaid - newTotalPrice : 0;

      return {
        message: "Pasajero cancelado exitosamente.",
        freedSeats: 1,
        financialSummary: {
          previousTotal: currentTotalPrice,
          newTotal: newTotalPrice,
          amountPaid: amountPaid,
          hasSurplus: isOverpaid,
          surplusAmount: surplusAmount,
        },
      };
    });
  }
}
