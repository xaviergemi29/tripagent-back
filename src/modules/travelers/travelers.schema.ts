import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
import {
  phoneCountrySchema,
  phoneSchema,
  refinePhoneCountry,
} from "../../shared/schemas/phone.schema.js";

export const getTravelerByIdParamsSchema = z.object({
  travelerId: z.uuid("El ID del viajero debe ser un UUID válido"),
});

export const baseTravelerSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3, "El nombre debe tener al menos 3 caracteres")
    .max(255, "El nombre es demasiado largo"),

  // Teléfonos internacionales: E.164 + país (shared/schemas/phone.schema.ts). Los 10 dígitos de
  // clientes anteriores se siguen aceptando como números mexicanos.
  whatsappPhone: phoneSchema.optional(),
  whatsappCountry: phoneCountrySchema,

  email: z.email("Correo electrónico inválido").max(255).optional(),

  emergencyContactName: z.string().trim().min(3, "Nombre de emergencia requerido").max(255),
  emergencyContactPhone: phoneSchema,
  emergencyContactCountry: phoneCountrySchema,
  medicalNotes: z.string().trim().optional(),
  birthDate: z.string().date("Debe ser formato YYYY-MM-DD").optional(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const getTravelersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

/** Lada del país = lada del número (WhatsApp y emergencia). */
export function refineTravelerPhones(
  data: {
    whatsappPhone?: string | undefined;
    whatsappCountry?: CountryCode | null | undefined;
    emergencyContactPhone?: string | undefined;
    emergencyContactCountry?: CountryCode | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  refinePhoneCountry(ctx, data.whatsappPhone, data.whatsappCountry, "whatsappPhone");
  refinePhoneCountry(
    ctx,
    data.emergencyContactPhone,
    data.emergencyContactCountry,
    "emergencyContactPhone",
  );
}

export const createTravelerBodySchema = baseTravelerSchema.superRefine(refineTravelerPhones);
export const updateTravelerBodySchema = baseTravelerSchema
  .partial()
  .superRefine(refineTravelerPhones);

export type CreateTravelerBody = z.infer<typeof createTravelerBodySchema>;
export type UpdateTravelerBody = z.infer<typeof updateTravelerBodySchema>;
export type GetTravelersQuery = z.infer<typeof getTravelersQuerySchema>;
