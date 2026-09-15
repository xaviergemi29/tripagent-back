import { z } from "zod";

// 1. Params Schema (Alineado con tours: UUID v4 explícito)
export const getTravelerByIdParamsSchema = z.object({
  id: z.uuid({
    version: "v4",
    message: "El ID del viajero debe ser un UUID válido",
  }),
});

// 2. Base Schema (Estricto por defecto, sin .optional() en campos requeridos)
export const baseTravelerSchema = z.object({
  fullName: z.string().trim().min(3, "El nombre debe tener al menos 3 caracteres"),
  
  // Implementación de Regex para estándar telefónico E.164
  whatsappPhone: z.string().trim().regex(/^(\+)?\d{10}$/, "Ingresa un número válido"),
  
  email: z.email("Correo electrónico inválido"),
  
  emergencyContactName: z.string().trim().min(3, "Nombre de emergencia requerido"),
  emergencyContactPhone: z.string().trim().regex(/^(\+)?\d{10}$/, "Ingresa un número de emergencia válido"),
  
  medicalNotes: z.string().trim().optional(), // Este campo sí es opcional operativamente
  
  // Usamos .default({}) para garantizar que siempre haya un objeto, incluso vacío
  customFields: z.record(z.string(), z.unknown()).default({}),
});

// 3. Query Schema (Idéntico a tours)
export const getTravelersQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0)
});

// 4. Body Schemas (Alineados con el patrón de tours)
export const createTravelerBodySchema = baseTravelerSchema;
// ✅ Corrección Crítica: Usamos .partial() para que los campos internos sean opcionales en el PATCH
export const updateTravelerBodySchema = baseTravelerSchema.partial(); 

// 5. Tipos inferidos limpios y estandarizados
export type CreateTravelerBody = z.infer<typeof createTravelerBodySchema>;
export type UpdateTravelerBody = z.infer<typeof updateTravelerBodySchema>;
export type GetTravelersQuery = z.infer<typeof getTravelersQuerySchema>;
