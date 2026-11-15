import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreatePaymentBody } from "./payments.schema.js";
import { bookings, PAYMENT_STATUS, payments } from "../../db/schema.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { summarizeRefunds } from "../../shared/utils/refund.util.js";
import { BookingStatusService } from "../bookings/booking-status.service.js";
import { lockBookingForUpdate } from "../bookings/booking-lock.util.js";

/** Liga una anulación con su abono: `voidPayment` escribe "(Ref: <id>)" en `referenceInfo`. */
const voidReference = (paymentId: string) => `(Ref: ${paymentId})`;

export class PaymentService {
  static async registerPayment(
    bookingId: string,
    data: CreatePaymentBody,
    agencyId: string,
    createdByUserId: string,
  ) {
    return db.transaction(async (tx) => {
      // 0. Candado de la reserva (serializa abonos y reembolsos simultáneos) + pertenencia.
      await lockBookingForUpdate(tx, bookingId, agencyId);

      // 1. Validar existencia y propiedad de la reserva
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
        with: { tour: { columns: { cancelledAt: true } } },
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada o no pertenece a esta agencia");

      // Tour cancelado por la agencia (decisión del PM, 2026-11-14): Modo Auditoría con una
      // excepción, los reembolsos. No entra dinero nuevo.
      if (booking.tour?.cancelledAt && data.type !== "REFUND") {
        throw new ConflictError(
          "El tour fue cancelado por la agencia: solo se pueden registrar reembolsos.",
        );
      }

      // Devoluciones en efectivo SOLO cuando la agencia cancela el tour (decisión del PM, 2026-11-14):
      // si cancela el cliente, la agencia retiene lo abonado como penalización. Las correcciones de
      // captura se hacen con "Anular" (voidPayment), no con un reembolso.
      if (data.type === "REFUND" && !booking.tour?.cancelledAt) {
        throw new ConflictError(
          "Los reembolsos solo aplican cuando la agencia cancela el tour. Para corregir un abono mal capturado, anúlalo.",
        );
      }

      // Un reembolso nunca devuelve más que el saldo a reembolsar (summarizeRefunds).
      if (data.type === "REFUND") {
        const maxRefund = summarizeRefunds({
          amountPaid: booking.amountPaid,
          totalPrice: booking.totalPrice,
          payments: [],
        }).refundableAmount;
        if (Math.abs(data.amount) > maxRefund + 0.005) {
          throw new BusinessRuleError(
            `El reembolso ($${Math.abs(data.amount).toFixed(2)}) supera el saldo a reembolsar ($${maxRefund.toFixed(2)}).`,
          );
        }
      }

      // 2. Lógica Financiera: Inversión de signo para Reembolsos
      const actualAmount = data.type === "REFUND" ? -Math.abs(data.amount) : Math.abs(data.amount);

      const actualCollectedAmount = data.collectedAmount
        ? data.type === "REFUND"
          ? -Math.abs(data.collectedAmount)
          : Math.abs(data.collectedAmount)
        : null;

      // 3. Registrar el movimiento en el Libro Mayor (Append-Only)
      const [newPayment] = await tx
        .insert(payments)
        .values({
          agencyId,
          bookingId,
          amount: actualAmount,
          currency: data.currency,
          collectedAmount: actualCollectedAmount,
          collectedCurrency: data.collectedCurrency || null,
          exchangeRate: data.exchangeRate || null,
          method: data.method,
          type: data.type,
          referenceInfo: data.referenceInfo,
          createdByUserId,
        })
        .returning();

      if (!newPayment) throw new Error("Error crítico al registrar el pago");

      // 4. Calcular el nuevo total pagado delegando la suma a PostgreSQL
      // COALESCE evita que retorne null si por alguna extraña razón no hubiera registros
      const [paymentSumResult] = await tx
        .select({
          totalPaid: sql<number>`COALESCE(SUM(${payments.amount}), 0)::numeric`,
        })
        .from(payments)
        .where(eq(payments.bookingId, bookingId));

      const newTotalPaid = Number(paymentSumResult?.totalPaid);
      const totalPrice = Number(booking.totalPrice);

      // 5. Máquina de Estados Financiera (State Machine)
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = "PARTIAL";

      // Un reembolso que deja la reserva en $0 o menos es REFUNDED, aunque el total sea $0 (reserva
      // cancelada sin penalización); antes caía en PAID porque 0 ≥ 0.
      if (data.type === "REFUND" && newTotalPaid <= 0) {
        newPaymentStatus = "REFUNDED";
      } else if (newTotalPaid >= totalPrice) {
        newPaymentStatus = "PAID";
      } else if (newTotalPaid <= 0) {
        newPaymentStatus = "PENDING";
      }

      // 6. Sincronizar el estado en la tabla de la Reserva (Bookings)
      await tx
        .update(bookings)
        .set({
          amountPaid: newTotalPaid,
          paymentStatus: newPaymentStatus,
          lastPaymentMethod: data.method,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // Regla del PM: al cubrir el anticipo (con formulario lleno) la reserva pasa a CONFIRMED.
      await BookingStatusService.syncStatus(tx, bookingId);

      // Retornamos un resumen limpio y útil para actualizar el Frontend (Optimistic UI)
      return {
        payment: newPayment,
        bookingBalance: {
          totalPrice,
          amountPaid: newTotalPaid,
          remainingBalance: Math.max(0, totalPrice - newTotalPaid),
          paymentStatus: newPaymentStatus,
        },
      };
    });
  }

  static async voidPayment(
    bookingId: string,
    paymentId: string,
    reason: string,
    agencyId: string,
    createdByUserId: string,
  ) {
    return db.transaction(async (tx) => {
      // 0. Candado de la reserva: dos anulaciones simultáneas del mismo abono se serializan.
      await lockBookingForUpdate(tx, bookingId, agencyId);

      // 1. Buscar el pago original (Usando las llaves foráneas correctas de la tabla payments)
      const originalPayment = await tx.query.payments.findFirst({
        where: and(
          eq(payments.bookingId, bookingId),
          eq(payments.agencyId, agencyId),
          eq(payments.id, paymentId),
        ),
      });

      if (!originalPayment) {
        throw new NotFoundError("El abono no existe o no pertenece a esta reserva");
      }

      // 🛡️ Regla de Negocio: No puedes anular un reembolso/anulación
      if (originalPayment.type !== "PAYMENT") {
        throw new BusinessRuleError("Solo se pueden anular abonos directos");
      }

      // Un abono se anula una sola vez (antes una segunda anulación restaba el monto otra vez y
      // dejaba `amountPaid` por debajo de lo realmente cobrado).
      const ledger = await tx.query.payments.findMany({
        where: eq(payments.bookingId, bookingId),
        columns: { type: true, referenceInfo: true },
      });
      const alreadyVoided = ledger.some(
        (entry) =>
          entry.type === "REFUND" &&
          (entry.referenceInfo ?? "").includes(voidReference(originalPayment.id)),
      );
      if (alreadyVoided) throw new ConflictError("Este abono ya fue anulado.");

      // 2. Transacción de compensación: Arrastramos todos los datos de conversión en negativo
      const [voidRecord] = await tx
        .insert(payments)
        .values({
          agencyId,
          bookingId,
          type: "REFUND",

          amount: -Math.abs(Number(originalPayment.amount)),
          currency: originalPayment.currency,

          // Propagamos la auditoría de caja en negativo para que la caja cierre a cero
          collectedAmount: originalPayment.collectedAmount
            ? -Math.abs(Number(originalPayment.collectedAmount))
            : null,
          collectedCurrency: originalPayment.collectedCurrency,
          exchangeRate: originalPayment.exchangeRate,

          method: originalPayment.method,
          referenceInfo: `Anulación: ${reason} ${voidReference(originalPayment.id)}`,
          createdByUserId,
        })
        .returning();

      if (!voidRecord) throw new Error("Error al generar el registro de anulación");

      // 3. Recalcular la deuda total
      const [paymentSumResult] = await tx
        .select({
          totalPaid: sql<number>`COALESCE(SUM(${payments.amount}), 0)::numeric`,
        })
        .from(payments)
        .where(eq(payments.bookingId, bookingId));

      const newTotalPaid = Number(paymentSumResult?.totalPaid);

      // 4. Obtener el precio total para evaluar la máquina de estados
      const booking = await tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
        columns: { totalPrice: true },
      });

      const totalPrice = Number(booking?.totalPrice || 0);

      // 5. Máquina de Estados Financiera (Recálculo)
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = "PARTIAL";
      if (newTotalPaid >= totalPrice) {
        newPaymentStatus = "PAID";
      } else if (newTotalPaid <= 0) {
        newPaymentStatus = "PENDING";
      }

      // 6. Actualizar el estado de la reserva
      await tx
        .update(bookings)
        .set({
          amountPaid: newTotalPaid,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // Si la anulación deja lo pagado por debajo del anticipo, la reserva vuelve a PENDING.
      await BookingStatusService.syncStatus(tx, bookingId);

      return {
        voidRecord,
        bookingBalance: {
          totalPrice,
          amountPaid: newTotalPaid,
          remainingBalance: Math.max(0, totalPrice - newTotalPaid),
          paymentStatus: newPaymentStatus,
        },
      };
    });
  }
}
