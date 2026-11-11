import { z } from "zod";

export const getTravelerByIdParamsSchema = z.object({
  travelerId: z.uuid("El ID del viajero debe ser un UUID válido"),
});

export const baseTravelerSchema = z.object({
  fullName: z.string().trim().min(3, "El nombre debe tener al menos 3 caracteres"),

  whatsappPhone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Debe ser un número exactamente a 10 dígitos")
    .optional(),

  email: z.email("Correo electrónico inválido").optional(),

  emergencyContactName: z.string().trim().min(3, "Nombre de emergencia requerido"),
  emergencyContactPhone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Debe ser un número de emergencia exactamente a 10 dígitos"),
  medicalNotes: z.string().trim().optional(),
  birthDate: z.string().date("Debe ser formato YYYY-MM-DD").optional(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const getTravelersQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export const createTravelerBodySchema = baseTravelerSchema;
export const updateTravelerBodySchema = baseTravelerSchema.partial();

export type CreateTravelerBody = z.infer<typeof createTravelerBodySchema>;
export type UpdateTravelerBody = z.infer<typeof updateTravelerBodySchema>;
export type GetTravelersQuery = z.infer<typeof getTravelersQuerySchema>;
