import { z } from "zod";

// Los tokens son 32 caracteres hex (UUID sin guiones); el límite evita consultas con basura enorme.
export const validateTokenParamsSchema = z.object({
  token: z.string().min(1, "El token no puede estar vacío").max(255),
});

export const lookupTravelerQuerySchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10}$/, "Ingresa un número válido"),
});
