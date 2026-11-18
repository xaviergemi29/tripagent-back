import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { BookingStatusService } from "../bookings/booking-status.service.js";
import { lockBookingForUpdate } from "../bookings/booking-lock.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { bookings, bookingPassengers, magicTokens } from "../../db/schema.js";
import {
  resolveAgreedUnitPrice,
  summarizeCompanionDrop,
} from "../../shared/utils/booking-rules.util.js";
import { formatMoney } from "../../shared/utils/money.util.js";
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
          tour: {
            columns: {
              price: true,
              currency: true,
              departureDateTime: true,
              returnDate: true,
              cancelledAt: true,
            },
          },
          magicToken: { columns: { numberPassengers: true } },
        },
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada");
      // Modo Auditoría (OBS-004): un tour FINALIZADO o CANCELADO no admite bajas.
      if (booking.tour) assertTourNotInAuditMode(booking.tour);
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

      // 4. Finanzas de la baja (FLUJO-RES-004 / PQ-C5; decisión del usuario, 2026-11-17). El lugar se
      // descuenta al precio PACTADO (`bookings.unitPrice`), nunca el total ya ajustado dividido entre
      // pasajeros. El operador puede capturar una retención para la agencia (0 … precio del lugar).
      // Lo abonado no cambia: si supera el nuevo total, queda un saldo a devolver al titular
      // (`refundableSurplus`) que se salda con un reembolso; ya no se retiene en automático.
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);
      const unitPrice = resolveAgreedUnitPrice({
        unitPrice: booking.unitPrice,
        totalPrice: currentTotalPrice,
        numberPassengers: booking.magicToken?.numberPassengers,
        tourPrice: booking.tour?.price,
      });

      if (penaltyAmount > unitPrice + 0.005) {
        const currency = booking.tour?.currency ?? "MXN";
        throw new BusinessRuleError(
          `La retención (${formatMoney(penaltyAmount, currency)}) no puede superar el precio del lugar (${formatMoney(unitPrice, currency)}).`,
        );
      }
      const financialSummary = summarizeCompanionDrop({
        currentTotal: currentTotalPrice,
        unitPrice,
        penaltyAmount,
        amountPaid,
      });
      const newTotalPrice = financialSummary.newTotal;

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

      // 8. Resumen para el operador: { previousTotal, newTotal, unitPrice, penaltyAmount,
      // nonRetainedAmount, pendingBalance, refundableSurplus, amountPaid }.
      return {
        message: "Pasajero cancelado exitosamente.",
        freedSeats: 1,
        financialSummary,
      };
    });
  }
}
