import z from "zod";
import { SUBSCRIPTION_STATUS } from "../../db/schema.js";

export const baseAgencySchema = z.object({
  name: z.string().trim().min(3, "La agencia debe tener al menos 3 caracteres"),
  phone: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10,}$/, "El teléfono debe contener solo números (mínimo 10 dígitos)"),
  logoUrl: z.url("Debe ser una URL válida").optional().or(z.literal("")),
  email: z.email("Correo electrónico inválido"),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUS.enumValues).default("trialing"),
  isActive: z.boolean().default(true),
  bankName: z.string().optional().nullable(),
  bankAccountHolder: z.string().optional().nullable(),

  clabeNumber: z
    .string("La CLABE es obligatoria")
    .trim()
    .regex(/^\d{18}$/, "La CLABE debe contener exactamente 18 números"),

  address: z
    .union([z.string().trim(), z.literal("")])
    .optional()
    .transform((e) => (e === "" ? null : e)),

  cardNumber: z
    .string("El número de tarjeta es obligatorio")
    .trim()
    .regex(/^\d{16}$/, "El número de tarjeta debe tener exactamente 16 dígitos"),
});

export const createAgencyBodySchema = baseAgencySchema;

export const updateAgencyBodySchema = baseAgencySchema.extend({
  trialEndsAt: z.iso.datetime("Debe ser una fecha ISO 8601 válida").optional(),
});

export const getAgencybyIdParamSchema = z.object({
  id: z.uuid("El ID de la agencia debe ser un UUID válido"),
});

export type CreateAgencyBody = z.infer<typeof createAgencyBodySchema>;
export type UpdateAgencyBody = z.infer<typeof updateAgencyBodySchema>;
export type GetAgencyByIdParams = z.infer<typeof getAgencybyIdParamSchema>;
