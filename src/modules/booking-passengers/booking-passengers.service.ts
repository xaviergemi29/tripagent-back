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
import { resolveAgreedUnitPrice } from "../../shared/utils/booking-rules.util.js";
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
      // Operar sobre un recurso cuyo estado ya cambió → 409 (decisión del usuario, 2026-11-17: el
      // 400 queda solo para datos mal formados).
      if (booking.status === "CANCELLED") {
        throw new ConflictError("La reserva ya está cancelada por completo");
      }

      // 2. El pasajero debe pertenecer a la reserva (404) y seguir activo (409 si ya se dio de baja).
      const passengerRows = await tx.query.bookingPassengers.findMany({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, travelerId),
        ),
      });
      const targetPassenger = passengerRows.find((row) => row.status === "ACTIVE");
      if (!targetPassenger) {
        if (passengerRows.length > 0) {
          throw new ConflictError("Este pasajero ya fue dado de baja.");
        }
        throw new NotFoundError("El pasajero no pertenece a esta reserva.");
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
        throw new ConflictError(
          "Es el último pasajero activo. Usa la función de Cancelación Total.",
        );
      }

      // 4. Descuento: un lugar al precio PACTADO (`bookings.unitPrice`, decisión del usuario,
      // 2026-11-17), nunca el total ya ajustado dividido entre pasajeros: ese total puede incluir
      // retenciones y alteraba el precio de los que sí viajan. Las retenciones previas se quedan en
      // el total, así que el nuevo total = precio × lugares restantes (+ retenciones, si las hubo).
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);
      const unitPrice = resolveAgreedUnitPrice({
        unitPrice: booking.unitPrice,
        totalPrice: currentTotalPrice,
        numberPassengers: booking.magicToken?.numberPassengers,
        tourPrice: booking.tour?.price,
      });

      // La interfaz siempre envía $0 (MVP); la API conserva el tope por si llega una retención.
      if (penaltyAmount > unitPrice) {
        throw new BusinessRuleError(
          `La penalización ($${penaltyAmount}) no puede superar el precio de un lugar ($${unitPrice}).`,
        );
      }
      // Si el grupo ya abonó más que el nuevo total, el excedente se retiene como penalización de la
      // baja (decisión del usuario, 2026-11-17): con $2,500 abonados de $3,000, la baja de un lugar
      // de $1,000 deja el total en $2,500 (no $2,000) y el saldo en $0. Así nunca queda un saldo a
      // favor sin salida (en el MVP solo hay reembolsos si la agencia cancela el tour). Tope: el precio
      // de un lugar, contando la retención que se haya enviado.
      const totalWithoutSeat = currentTotalPrice - unitPrice;
      const excessPaid = amountPaid - (totalWithoutSeat + penaltyAmount);
      const automaticRetention = Math.min(Math.max(0, excessPaid), unitPrice - penaltyAmount);
      const retainedAmount = Math.round((penaltyAmount + automaticRetention) * 100) / 100;
      const newTotalPrice = Math.max(0, totalWithoutSeat + retainedAmount);

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
          // Lo que se retuvo por esta baja (enviado + excedente retenido automáticamente).
          retainedAmount,
          // Solo en una reserva anterior pagada de más del precio de un lugar (hoy no ocurre).
          hasSurplus: isOverpaid,
          surplusAmount: surplusAmount,
        },
      };
    });
  }
}
