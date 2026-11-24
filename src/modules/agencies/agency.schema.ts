import z from "zod";
import { SUBSCRIPTION_STATUS } from "../../db/schema.js";
import { policiesTextSchema } from "../../shared/schemas/policies.schema.js";
import { SUBSCRIPTION_CANCELLATION_REASONS } from "../../shared/constants/domain.constants.js";
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
  // `null` también se acepta: el formulario de Configuración reenvía la dirección tal como la
  // leyó, y una agencia sin dirección no podía guardar ningún cambio (400 en `body/address`).
  address: z
    .union([z.string().trim(), z.literal("")])
    .nullish()
    .transform((e) => (e === "" ? null : e)),

  // Enlace al aviso de privacidad (LFPDPPP), opcional. Vacío → null; sin enviar → no cambia.
  privacyNoticeUrl: z
    .union([z.url("El aviso de privacidad debe ser un enlace válido (https://…)"), z.literal("")])
    .nullish()
    .transform((value) => (value === "" ? null : value)),
});

/**
 * `PATCH /agencies` (Configuración → Agencia): solo el perfil. Las cuentas bancarias tienen sus
 * propios endpoints (`/agencies/bank-accounts`): Zod descarta `bankName`, `clabeNumber`, etc.
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
 * Cuenta bancaria de la agencia (`POST /agencies/bank-accounts`). Banco y titular obligatorios;
 * CLABE de 18 dígitos; tarjeta opcional de 16 dígitos ("" o null → null).
 */
export const createBankAccountBodySchema = z.object({
  bankName: z.string("El banco es obligatorio").trim().min(1, "El banco es obligatorio").max(100),
  accountHolder: z
    .string("El titular es obligatorio")
    .trim()
    .min(1, "El titular es obligatorio")
    .max(255),
  clabeNumber: z
    .string("La CLABE es obligatoria")
    .trim()
    .regex(/^\d{18}$/, "La CLABE debe contener exactamente 18 números"),
  cardNumber: z
    .string()
    .trim()
    .regex(/^(\d{16})?$/, "El número de tarjeta debe tener exactamente 16 dígitos")
    .nullish()
    .transform((value) => (value === "" ? null : value)),
});

/** `PATCH /agencies/bank-accounts/:id`: mismos campos, todos opcionales, al menos uno. */
export const updateBankAccountBodySchema = createBankAccountBodySchema
  .partial()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Envía al menos un campo para actualizar",
  });

export const bankAccountParamsSchema = z.object({
  id: z.uuid("Id de cuenta bancaria inválido"),
});

/** PATCH /agencies/policies: políticas generales de la agencia. `""` o `null` las quita. */
export const updatePoliciesBodySchema = z.object({ policies: policiesTextSchema });

export type UpdateAgencyBody = z.infer<typeof updateAgencyBodySchema>;
export type CreateBankAccountBody = z.infer<typeof createBankAccountBodySchema>;
export type UpdateBankAccountBody = z.infer<typeof updateBankAccountBodySchema>;
export type UpdateBrandingBody = z.infer<typeof updateBrandingBodySchema>;

/** Baja programada de la suscripción (POST /agencies/subscription/cancel). */
export const cancelSubscriptionBodySchema = z.object({
  reason: z.enum(SUBSCRIPTION_CANCELLATION_REASONS, "Selecciona un motivo"),
  comments: z.string().trim().max(500, "El comentario admite máximo 500 caracteres").optional(),
});
