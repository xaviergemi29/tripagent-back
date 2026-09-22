import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreatePaymentBody } from "./payments.schema.js";
import { bookings, PAYMENT_STATUS, payments } from "../../db/schema.js";

export class PaymentService {
  static async registerPayment(
    bookingId: string,
    data: CreatePaymentBody,
    agencyId: string,
    createdByUserId: string,
  ) {
    return await db.transaction(async (tx) => {
      // 1. Validar existencia y propiedad de la reserva
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada o no pertenece a esta agencia");

      // 2. Lógica Financiera: Inversión de signo para Reembolsos
      const actualAmount = data.type === "REFUND" ? -Math.abs(data.amount) : Math.abs(data.amount);

      // 3. Registrar el movimiento en el Libro Mayor (Append-Only)
      const [newPayment] = await tx
        .insert(payments)
        .values({
          agencyId,
          bookingId,
          amount: actualAmount, // Guardamos el valor firmado (ej. 500 o -500)
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

      if (newTotalPaid >= totalPrice) {
        newPaymentStatus = "PAID";
      } else if (newTotalPaid <= 0) {
        newPaymentStatus = data.type === "REFUND" ? "REFUNDED" : "PENDING";
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
    return await db.transaction(async (tx) => {
      // 1. Buscar el pago original (Usando las llaves foráneas correctas de la tabla payments)
      const originalPayment = await tx.query.payments.findFirst({
        where: and(
          eq(payments.bookingId, bookingId),
          eq(payments.agencyId, agencyId),
          eq(payments.id, paymentId),
        ),
      });

      if (!originalPayment) throw new Error("El abono no existe o no pertenece a esta reserva");

      // 🛡️ Regla de Negocio: No puedes anular un reembolso/anulación
      if (originalPayment.type !== "PAYMENT")
        throw new Error("Solo se pueden anular abonos directos");

      // 2. Insertar la Transacción de Compensación
      const [voidRecord] = await tx
        .insert(payments)
        .values({
          agencyId,
          bookingId,
          type: "REFUND",
          amount: -Math.abs(Number(originalPayment.amount)),
          method: originalPayment.method,
          referenceInfo: `Anulación: ${reason} (Ref: ${originalPayment.id})`,
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
        // 👈 FIX: Comparamos contra la llave foránea bookingId, no contra el id del pago
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
