import { z } from "zod";
import { phoneSchema } from "../../shared/schemas/phone.schema.js";

// Los tokens son 32 caracteres hex (UUID sin guiones); el límite evita consultas con basura enorme.
export const validateTokenParamsSchema = z.object({
  token: z.string().min(1, "El token no puede estar vacío").max(255),
});

export const lookupTravelerQuerySchema = z.object({
  // E.164 (front actual; el "+" llega codificado como %2B) o 10 dígitos de clientes anteriores.
  phone: phoneSchema,
});
