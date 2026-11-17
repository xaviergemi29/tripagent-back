import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { BookingStatusService } from "../bookings/booking-status.service.js";
import { lockBookingForUpdate } from "../bookings/booking-lock.util.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { bookings, bookingPassengers, magicTokens } from "../../db/schema.js";
import { getExpectedGroupSize } from "../../shared/utils/booking-rules.util.js";
import { derivePaymentStatus } from "../../shared/utils/payment-status.util.js";

export class BookingPassengerService {
  static async cancelPassenger(
    bookingId: string,
    travelerId: string,
    penaltyAmount: number,
    agencyId: string,
  ) {
    return db.transaction(async (tx) => {
      // Candado: dos bajas simultáneas del mismo grupo no calculan el precio unitario con el mismo
      // número de activos (ni pueden dejar el grupo sin pasajeros).
      await lockBookingForUpdate(tx, bookingId, agencyId);

      // 1. Validar la reserva maestra
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
        with: {
          tour: { columns: { price: true } },
          magicToken: { columns: { numberPassengers: true } },
        },
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada");
      if (booking.status === "CANCELLED")
        throw new BusinessRuleError("La reserva ya está cancelada por completo");

      // 2. Verificar pasajero ACTIVO
      const targetPassenger = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, travelerId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      if (!targetPassenger) {
        throw new BusinessRuleError("El pasajero no existe o ya fue cancelado");
      }

      // El titular es el responsable financiero: no se da de baja por aquí (decisión del usuario,
      // 2026-11-17). Antes la reserva quedaba sin titular activo y desaparecía del Centro de Control
      // aunque seguía ocupando lugares y conservaba su dinero.
      if (targetPassenger.isTitular) {
        throw new ConflictError(
          "No se puede dar de baja al titular: transfiere la titularidad o cancela la reserva completa.",
        );
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
        throw new BusinessRuleError(
          "Es el último pasajero activo. Usa la función de Cancelación Total.",
        );
      }

      // 4. Matemáticas Financieras: El descuento
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);
      // Precio de un lugar = total ÷ lugares APARTADOS (decisión del usuario, 2026-11-17; mismo
      // `unitPrice` que muestra el Centro de Control). Antes se dividía entre los pasajeros activos y,
      // con lugares aún sin registrar, se descontaba de más: 3 lugares de $1,000 con 2 registrados
      // descontaban $1,500 al dar de baja a uno. Nunca menos que los activos (dato inconsistente).
      const groupSize = Math.max(
        activeCount,
        getExpectedGroupSize(
          booking.magicToken?.numberPassengers,
          currentTotalPrice,
          Number(booking.tour?.price),
        ),
      );
      const unitPrice = currentTotalPrice / groupSize;

      // 🛡️ Validación Defensiva: No puedes penalizar por un monto mayor a lo que cuesta el boleto
      if (penaltyAmount > unitPrice) {
        throw new BusinessRuleError(
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

      // 6. Estado de pago con la regla única (antes: total $0 sin dinero daba PAID).
      const newPaymentStatus = derivePaymentStatus({
        amountPaid,
        totalPrice: newTotalPrice,
        hasRefund: booking.paymentStatus === "REFUNDED",
      });

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
      await BookingStatusService.syncStatus(tx, bookingId);

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
