import { z } from "zod";
// Asegúrate de exportar e importar bien tus Enums desde tu schema.ts
import { PAYMENT_METHOD, PAYMENT_TYPE } from "../../db/schema.js";

export const createPaymentParamsSchema = z.object({
    bookingId: z.uuid("ID de reserva inválido"),
});

export const createPaymentBodySchema = z.object({
    // Siempre validamos montos positivos en la entrada
    amount: z.number().positive("El monto debe ser mayor a 0"),
    method: z.enum(PAYMENT_METHOD.enumValues, "Método de pago requerido"),
    type: z.enum(PAYMENT_TYPE.enumValues).default("PAYMENT"),
    referenceInfo: z.string().trim().optional(),
});

export const voidPaymentParamsSchema = z.object({
    bookingId: z.uuid("ID de reserva inválido"),
    paymentId: z.uuid("ID de pago inválido"),
});

export const voidPaymentBodySchema = z.object({
    reason: z.string().min(3, "Debes proporcionar un motivo de anulación").default("Error de captura"),
});

export type VoidPaymentBody = z.infer<typeof voidPaymentBodySchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;
