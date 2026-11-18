import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreatePaymentBody } from "./payments.schema.js";
import { bookings, payments } from "../../db/schema.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { summarizeRefunds } from "../../shared/utils/refund.util.js";
import { getRefundableSurplus } from "../../shared/utils/booking-rules.util.js";
import { derivePaymentStatus, ledgerHasRefund } from "../../shared/utils/payment-status.util.js";
import { formatMoney } from "../../shared/utils/money.util.js";
import { BookingStatusService } from "../bookings/booking-status.service.js";
import { lockBookingForUpdate } from "../bookings/booking-lock.util.js";
import { TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";

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
        with: {
          tour: {
            columns: {
              cancelledAt: true,
              currency: true,
              departureDateTime: true,
              returnDate: true,
            },
          },
        },
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada o no pertenece a esta agencia");

      // Modo Auditoría (OBS-004): un tour FINALIZADO no admite abonos ni reembolsos. El CANCELADO
      // conserva su excepción (solo reembolsos), que se valida abajo.
      if (
        booking.tour &&
        getTourTemporalStatus(
          booking.tour.departureDateTime,
          booking.tour.cancelledAt,
          booking.tour.returnDate,
        ) === TOUR_TEMPORAL_STATUS.FINISHED
      ) {
        assertTourNotInAuditMode(booking.tour);
      }

      // Tour cancelado por la agencia (decisión del PM, 2026-11-14): Modo Auditoría con una
      // excepción, los reembolsos. No entra dinero nuevo.
      if (booking.tour?.cancelledAt && data.type !== "REFUND") {
        throw new ConflictError(
          "El tour fue cancelado por la agencia: solo se pueden registrar reembolsos.",
        );
      }

      // Devoluciones en efectivo (regla 18 de `../CLAUDE.md`):
      // - tour cancelado por la agencia (decisión del PM, 2026-11-14): tope = saldo a reembolsar
      //   (`summarizeRefunds`);
      // - tour NO cancelado (excepción controlada, decisión del usuario, 2026-11-17): solo si la reserva
      //   activa tiene `refundableSurplus` > 0 (abonado > total, p. ej. tras la baja de un acompañante
      //   con retención menor al lugar), con tope EXACTO en ese `refundableSurplus`. Con saldo a favor
      //   en $0 → 409.
      // Si cancela el cliente, la agencia retiene lo abonado: no hay devolución. Las correcciones de
      // captura se hacen con "Anular" (voidPayment), no con un reembolso.
      if (data.type === "REFUND") {
        let maxRefund: number;
        if (booking.tour?.cancelledAt) {
          maxRefund = summarizeRefunds({
            amountPaid: booking.amountPaid,
            totalPrice: booking.totalPrice,
            payments: [],
          }).refundableAmount;
        } else {
          maxRefund =
            booking.status === "CANCELLED"
              ? 0
              : getRefundableSurplus({
                  amountPaid: Number(booking.amountPaid),
                  totalPrice: Number(booking.totalPrice),
                });
          if (maxRefund <= 0) {
            throw new ConflictError(
              "Solo se registra un reembolso cuando la agencia cancela el tour o cuando la reserva tiene saldo a devolver. Para corregir un abono mal capturado, anúlalo.",
            );
          }
        }
        if (Math.abs(data.amount) > maxRefund + 0.005) {
          throw new BusinessRuleError(
            `El reembolso ($${Math.abs(data.amount).toFixed(2)}) supera el saldo a reembolsar ($${maxRefund.toFixed(2)}).`,
          );
        }
      }

      if (data.type === "PAYMENT") {
        // Reserva cancelada por el cliente: queda congelada para ingresos (decisión del usuario,
        // 2026-11-17). Antes se aceptaba "para cubrir la retención"; no tiene uso real y abría la
        // puerta a abonos duplicados o fuera de tiempo.
        if (booking.status === "CANCELLED") {
          throw new ConflictError("La reserva está cancelada: ya no se pueden registrar abonos.");
        }
        // Un abono nunca supera el saldo pendiente (decisión del usuario, 2026-11-17): antes un
        // $5,000 tecleado por $500 se aceptaba y dejaba dinero sin explicación en el corte del tour.
        const pendingBalance =
          Math.round((Number(booking.totalPrice) - Number(booking.amountPaid)) * 100) / 100;
        if (data.amount > pendingBalance + 0.005) {
          throw new BusinessRuleError(
            `El abono no puede superar el saldo pendiente de ${formatMoney(
              Math.max(0, pendingBalance),
              booking.tour?.currency ?? data.currency,
            )}.`,
          );
        }
      }

      // Libro de la reserva (para saber si ya hubo devoluciones reales: estado REFUNDED).
      const ledger = await tx.query.payments.findMany({
        where: eq(payments.bookingId, bookingId),
        columns: { type: true, amount: true, referenceInfo: true },
      });

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

      // 5. Estado de pago con la regla única (un reembolso que deja $0 o menos → REFUNDED).
      const newPaymentStatus = derivePaymentStatus({
        amountPaid: newTotalPaid,
        totalPrice,
        hasRefund: ledgerHasRefund([...ledger, newPayment]),
      });

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

      // Modo Auditoría (OBS-004): no se anulan abonos de un tour FINALIZADO o CANCELADO.
      const bookingTour = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
        columns: { id: true },
        with: {
          tour: { columns: { departureDateTime: true, returnDate: true, cancelledAt: true } },
        },
      });
      if (bookingTour?.tour) assertTourNotInAuditMode(bookingTour.tour);

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

      // Un reembolso o una anulación no se anulan: 409, como toda operación sobre un movimiento que
      // ya no admite ese cambio (decisión del usuario, 2026-11-17; antes 400).
      if (originalPayment.type !== "PAYMENT") {
        throw new ConflictError("Solo se pueden anular abonos directos");
      }

      // Un abono se anula una sola vez (antes una segunda anulación restaba el monto otra vez y
      // dejaba `amountPaid` por debajo de lo realmente cobrado).
      const ledger = await tx.query.payments.findMany({
        where: eq(payments.bookingId, bookingId),
        columns: { type: true, amount: true, referenceInfo: true },
      });
      const alreadyVoided = ledger.some(
        (entry) =>
          entry.type === "REFUND" &&
          (entry.referenceInfo ?? "").includes(voidReference(originalPayment.id)),
      );
      if (alreadyVoided) throw new ConflictError("Este abono ya fue anulado.");

      // Una anulación no puede dejar lo pagado en negativo (decisión del usuario, 2026-11-17): si ese
      // dinero ya se devolvió con un reembolso, anularlo lo descontaría dos veces.
      const netPaidBefore = ledger.reduce((sum, entry) => sum + Number(entry.amount), 0);
      if (netPaidBefore - Math.abs(Number(originalPayment.amount)) < -0.005) {
        throw new ConflictError(
          "No se puede anular: ese dinero ya se devolvió con un reembolso y lo pagado quedaría en negativo.",
        );
      }

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
        columns: { totalPrice: true, status: true },
        with: { tour: { columns: { cancelledAt: true } } },
      });

      // Reserva cancelada por el CLIENTE: la retención es lo realmente abonado (decisión del usuario,
      // 2026-11-17). Si después se anula un abono mal capturado (p. ej. efectivo que nunca llegó), la
      // retención baja con él; antes quedaba una "deuda" imposible de cobrar, porque una reserva
      // cancelada ya no acepta abonos. Si canceló la agencia, el total es $0 y no se toca.
      const isClientCancelled = booking?.status === "CANCELLED" && !booking.tour?.cancelledAt;
      const totalPrice = isClientCancelled
        ? Math.max(0, newTotalPaid)
        : Number(booking?.totalPrice || 0);

      // 5. Estado de pago con la regla única (antes: total $0 y sin dinero daba PAID).
      const newPaymentStatus = derivePaymentStatus({
        amountPaid: newTotalPaid,
        totalPrice,
        hasRefund: ledgerHasRefund(ledger),
      });

      // 6. Actualizar el estado de la reserva
      await tx
        .update(bookings)
        .set({
          amountPaid: newTotalPaid,
          paymentStatus: newPaymentStatus,
          ...(isClientCancelled ? { totalPrice } : {}),
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
