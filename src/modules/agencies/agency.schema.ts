import z from "zod";
import { SUBSCRIPTION_STATUS } from "../../db/schema.js";
import { policiesTextSchema } from "../../shared/schemas/policies.schema.js";
import {
  phoneCountrySchema,
  phoneSchema,
  refinePhoneCountry,
} from "../../shared/schemas/phone.schema.js";

export const baseAgencySchema = z.object({
  name: z.string().trim().min(3, "La agencia debe tener al menos 3 caracteres").max(255),
  // WhatsApp oficial: E.164 + país (2026-11-16; antes solo dígitos con un "+52" visual).
  phone: phoneSchema,
  phoneCountry: phoneCountrySchema,
  email: z.email("Correo electrónico inválido").max(255),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUS.enumValues).default("trialing"),
  isActive: z.boolean().default(true),
  bankName: z.string().max(100).optional().nullable(),
  bankAccountHolder: z.string().max(255).optional().nullable(),

  clabeNumber: z
    .string("La CLABE es obligatoria")
    .trim()
    .regex(/^\d{18}$/, "La CLABE debe contener exactamente 18 números"),

  // `null` también se acepta: el formulario de Configuración reenvía la dirección tal como la
  // leyó, y una agencia sin dirección no podía guardar ningún cambio (400 en `body/address`).
  address: z
    .union([z.string().trim(), z.literal("")])
    .nullish()
    .transform((e) => (e === "" ? null : e)),

  // Opcional (decisión del PM, 2026-11-14): en México se cobra sobre todo por SPEI/CLABE.
  // Vacío → null (la agencia quita su tarjeta); sin enviar → no se modifica.
  // Enlace al aviso de privacidad (LFPDPPP), opcional. Vacío → null; sin enviar → no cambia.
  privacyNoticeUrl: z
    .union([z.url("El aviso de privacidad debe ser un enlace válido (https://…)"), z.literal("")])
    .nullish()
    .transform((value) => (value === "" ? null : value)),

  cardNumber: z
    .union([
      z
        .string()
        .trim()
        .regex(/^\d{16}$/, "El número de tarjeta debe tener exactamente 16 dígitos"),
      z.literal(""),
    ])
    .nullish()
    .transform((value) => (value === "" ? null : value)),
});

/**
 * `PATCH /agencies` (Configuración → Agencia): solo perfil y datos bancarios.
 * Sin `subscriptionStatus`, `isActive` ni `trialEndsAt` (2026-11-14): con los valores por defecto
 * del schema base, cada guardado regresaba la agencia a "trialing" y la reactivaba; además, un
 * operador podía activar su suscripción o extender su prueba desde la API. La facturación la
 * administra TripAgent (alta por CLI). Zod descarta esas claves si llegan en el cuerpo.
 */
export const updateAgencyBodySchema = baseAgencySchema
  .omit({
    subscriptionStatus: true,
    isActive: true,
  })
  .superRefine((data, ctx) => refinePhoneCountry(ctx, data.phone, data.phoneCountry, "phone"));

// ----------------------------------------------------------------------------
// Identidad visual (agency_branding). El logotipo NO viaja aquí: se sube como archivo
// (POST /agencies/logo) y se guarda en agencies.logoPath.
// ----------------------------------------------------------------------------

/** Color hex `#RGB` o `#RRGGBB`; se normaliza a `#rrggbb` (jsPDF no maneja transparencia). */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Debe ser un color hexadecimal (#RRGGBB)")
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return hex.length === 3
      ? `#${hex
          .split("")
          .map((c) => c + c)
          .join("")}`
      : `#${hex}`;
  });

/** PATCH parcial: solo se escriben los colores enviados. `accentColor: null` lo quita. */
export const updateBrandingBodySchema = z
  .object({
    primaryColor: hexColorSchema,
    secondaryColor: hexColorSchema,
    accentColor: hexColorSchema.nullable(),
  })
  .partial();

/**
 * PATCH /agencies/bank-account (OBS-038, 2026-11-17): solo la cuenta para transferencias, desde el
 * modal "Configurar cuenta ahora" del formulario de tours (sin salir del formulario ni reenviar el
 * perfil completo). Mismas reglas que `PATCH /agencies`: CLABE de 18 dígitos (obligatoria), banco
 * y titular opcionales (vacío → null).
 */
export const updateBankAccountBodySchema = z.object({
  bankName: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((value) => value || null),
  bankAccountHolder: z
    .string()
    .trim()
    .max(255)
    .nullish()
    .transform((value) => value || null),
  clabeNumber: baseAgencySchema.shape.clabeNumber,
});

/** PATCH /agencies/policies: políticas generales de la agencia. `""` o `null` las quita. */
export const updatePoliciesBodySchema = z.object({ policies: policiesTextSchema });

export type UpdateAgencyBody = z.infer<typeof updateAgencyBodySchema>;
export type UpdateBankAccountBody = z.infer<typeof updateBankAccountBodySchema>;
export type UpdateBrandingBody = z.infer<typeof updateBrandingBodySchema>;
