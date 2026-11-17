import { z } from "zod";
import { PAYMENT_METHOD, PAYMENT_TYPE, CURRENCIES } from "../../db/schema.js";

export const createPaymentParamsSchema = z.object({
  bookingId: z.uuid("ID de reserva inválido"),
});

export const createPaymentBodySchema = z.object({
  amount: z.number().positive("El monto debe ser mayor a 0"),
  currency: z.enum(CURRENCIES.enumValues).default("MXN"),
  collectedAmount: z.number().positive().optional(),
  collectedCurrency: z.enum(CURRENCIES.enumValues).optional(),
  exchangeRate: z.number().positive().optional(),
  method: z.enum(PAYMENT_METHOD.enumValues, "Método de pago requerido"),
  type: z.enum(PAYMENT_TYPE.enumValues).default("PAYMENT"),
  referenceInfo: z
    .string()
    .trim()
    .max(500, "La referencia admite máximo 500 caracteres")
    .optional(),
});

export const voidPaymentParamsSchema = z.object({
  bookingId: z.uuid("ID de reserva inválido"),
  paymentId: z.uuid("ID de pago inválido"),
});

export const voidPaymentBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Debes proporcionar un motivo de anulación")
    .max(300, "El motivo admite máximo 300 caracteres")
    .default("Error de captura"),
});

export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;
