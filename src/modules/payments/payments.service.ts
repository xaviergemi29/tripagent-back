import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreatePaymentBody } from "./payments.schema.js";
import { agencies, bookings, PAYMENT_STATUS, payments } from "../../db/schema.js";


export class PaymentService {
    static async registerPayment(bookingId: string, data: CreatePaymentBody, agencyId: string) {
        return await db.transaction(async (tx) => {
            // 1. Validar existencia y propiedad de la reserva
            const booking = await tx.query.bookings.findFirst({
                where: and(
                    eq(bookings.id, bookingId),
                    eq(bookings.agencyId, agencyId)
                )
            })

            if (!booking) throw new Error("Reserva no encontrada o no pertenece a esta agencia");

            // 2. Lógica Financiera: Inversión de signo para Reembolsos
            const actualAmount = data.type === "REFUND"
                ? -Math.abs(data.amount)
                : Math.abs(data.amount);

            // 3. Registrar el movimiento en el Libro Mayor (Append-Only)
            const [newPayment] = await tx.insert(payments).values({
                agencyId,
                bookingId,
                amount: actualAmount, // Guardamos el valor firmado (ej. 500 o -500)
                method: data.method,
                type: data.type,
                referenceInfo: data.referenceInfo
            }).returning();

            if (!newPayment) throw new Error("Error crítico al registrar el pago");

            // 4. Calcular el nuevo total pagado delegando la suma a PostgreSQL
            // COALESCE evita que retorne null si por alguna extraña razón no hubiera registros

            const [paymentSumResult] = await tx.select({
                totalPaid: sql<number>`COALESCE(SUM(${payments.amount}), 0)::numeric`
            })
                .from(payments)
                .where(eq(payments.bookingId, bookingId))

            const newTotalPaid = Number(paymentSumResult?.totalPaid);
            const totalPrice = Number(booking.totalPrice);

            // 5. Máquina de Estados Financiera (State Machine)
            let newPaymentStatus: typeof PAYMENT_STATUS.enumValues[number] = "PARTIAL";

            if (newTotalPaid >= totalPrice) {
                newPaymentStatus = "PAID";
            } else if (newTotalPaid <= 0) {
                newPaymentStatus = data.type === "REFUND" ? "REFUNDED" : "PENDING";
            }

            // 6. Sincronizar el estado en la tabla de la Reserva (Bookings)
            await tx.update(bookings)
                .set({
                    amountPaid: newTotalPaid,
                    paymentStatus: newPaymentStatus,
                    lastPaymentMethod: data.method,
                    updatedAt: new Date().toISOString()
                })
                .where(eq(bookings.id, bookingId));

            // Retornamos un resumen limpio y útil para actualizar el Frontend (Optimistic UI)
            return {
                payment: newPayment,
                bookingBalance: {
                    totalPrice,
                    amountPaid: newTotalPaid,
                    remainingBalance: Math.max(0, totalPrice - newTotalPaid),
                    paymentStatus: newPaymentStatus
                }
            };
        })
    }

    static async voidPayment(bookingId: string, paymentId: string, reason: string, agencyId: string) {
        return await db.transaction(async (tx) => {
            // 1. Buscar el pago original y validar propiedad
            const originalPayment = await tx.query.payments
                .findFirst({
                    where: and(
                        eq(bookings.id, bookingId),
                        eq(agencies.id, agencyId),
                        eq(payments.id, paymentId)
                    )
                });

            if (!originalPayment) throw new Error("El abono no existe o no pertenece a esta reserva");

            // 🛡️ Regla de Negocio: No puedes anular un reembolso/anulación
            if (originalPayment.type !== "PAYMENT") throw new Error("Solo se pueden anular abonos directos");

            // 2. Insertar la Transacción de Compensación
            // Invertimos el signo del monto original y agregamos una nota de rastreo

            const [voidRecord] = await tx
                .insert(payments)
                .values({
                    agencyId,
                    bookingId,
                    type: "REFUND",
                    amount: originalPayment.amount,
                    method: originalPayment.method, // Conservamos el método original (CASH, TRANSFER, etc.)
                    referenceInfo: `Anulación: ${reason} (Ref: ${originalPayment.id})`
                }).returning();

            // 3. Recalcular la deuda total delegando la matemática a PostgreSQL

        })
    }
}