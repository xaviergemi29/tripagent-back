import z from "zod";
import {
  phoneCountrySchema,
  phoneSchema,
  refinePhoneCountry,
} from "../../shared/schemas/phone.schema.js";

export const loginBodySchema = z.object({
  // trim/minúsculas ANTES de validar: z.email().trim() valida primero y rechazaba " a@b.mx"
  // (2026-11-22). Los correos se guardan en minúsculas (CLI y /registro).
  email: z.string().trim().toLowerCase().pipe(z.email("Correo electrónico inválido")),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1, "La contraseña actual es requerida"),
    newPassword: z.string().min(6, "La nueva contraseña debe tener al menos 6 caracteres"),
    confirmPassword: z.string().min(6, "Confirma la nueva contraseña"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "La nueva contraseña no puede ser igual a la actual",
    path: ["newPassword"],
  });

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;

/**
 * Alta de agencia desde la web (`POST /auth/register-agency`, página /registro; 2026-11-22).
 * Espejo: `tripagent-front/src/features/auth/schemas/register-agency.schema.ts`. El WhatsApp es
 * internacional (E.164 + país, regla 21). `plan` es informativo: hoy hay un solo plan.
 */
export const registerAgencyBodySchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, "Ingresa tu nombre completo")
      .max(80, "Nombre demasiado largo"),
    agencyName: z
      .string()
      .trim()
      .min(2, "Ingresa el nombre comercial de tu agencia")
      .max(100, "Nombre de agencia demasiado largo"),
    whatsapp: phoneSchema,
    whatsappCountry: phoneCountrySchema,
    // trim/minúsculas ANTES de validar (z.email().trim() valida primero y rechaza " a@b.mx").
    email: z.string().trim().toLowerCase().pipe(z.email("Ingresa un correo electrónico válido")),
    password: z
      .string()
      .min(8, "La contraseña debe tener mínimo 8 caracteres")
      .max(72, "La contraseña es demasiado larga"),
    plan: z.string().trim().max(40).optional(),
  })
  .superRefine((data, ctx) =>
    refinePhoneCountry(ctx, data.whatsapp, data.whatsappCountry, "whatsapp"),
  );

export type RegisterAgencyBody = z.infer<typeof registerAgencyBodySchema>;
