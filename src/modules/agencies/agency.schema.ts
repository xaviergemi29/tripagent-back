import z from "zod";
import { SUBSCRIPTION_STATUS } from "../../db/schema.js";

export const baseAgencySchema = z.object({
  name: z.string().trim().min(3, "La agencia debe tener al menos 3 caracteres"),
  slug: z.string().trim().min(3, "El Slug debe tener al menos 3 caracteres"),
  phone: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10}$/, "Debe ser un teléfono válido (E.164)"),
  logoUrl: z.url("Debe ser una URL válida").optional().or(z.literal("")),
  email: z.email("Correo electrónico inválido"),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUS.enumValues).default("trialing"),
  isActive: z.boolean().default(true),
  bankName: z.string().optional().nullable(),
  bankAccountHolder: z.string().optional().nullable(),
  clabeNumber: z.string().max(18, "Máximo 18 dígitos").optional().nullable(),
});

export const createAgencyBodySchema = baseAgencySchema;

export const updateAgencyBodySchema = baseAgencySchema
  .extend({
    trialEndsAt: z.iso.datetime("Debe ser una fecha ISO 8601 válida").optional(),
  })
  .partial();

export const getAgencybyIdParamSchema = z.object({
  id: z.uuid("El ID de la agencia debe ser un UUID válido"),
});

export type CreateAgencyBody = z.infer<typeof createAgencyBodySchema>;
export type UpdateAgencyBody = z.infer<typeof updateAgencyBodySchema>;
export type GetAgencyByIdParams = z.infer<typeof getAgencybyIdParamSchema>;
