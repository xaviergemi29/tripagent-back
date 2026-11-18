import { z } from "zod";
import {
  BIRTH_DATE_REQUIRED_ERROR,
  FUTURE_BIRTH_DATE_ERROR,
  isFutureDate,
} from "../../shared/utils/mexico-date.util.js";
import { baseTravelerSchema } from "../travelers/travelers.schema.js";
import { PASSENGER_TYPE } from "../../db/schema.js";
import { PASSENGER_ROLE, PASSENGER_ROLES } from "../../shared/constants/domain.constants.js";
import {
  optionalPhoneSchema,
  phoneCountrySchema,
  phoneSchema,
  refinePhoneCountry,
} from "../../shared/schemas/phone.schema.js";
import { refineTravelerPhones } from "../travelers/travelers.schema.js";

/**
 * Fecha de nacimiento del registro del Magic Link: obligatoria (seguro carretero, igual que "Editar
 * viajero") y no futura. Hasta el 2026-11-17 se aceptaba vacía (petición del usuario).
 */
const requiredBirthDate = z
  .string(BIRTH_DATE_REQUIRED_ERROR)
  .trim()
  .min(1, BIRTH_DATE_REQUIRED_ERROR)
  .pipe(
    z
      .string()
      .date("Debe ser formato YYYY-MM-DD")
      .refine((date) => !isFutureDate(date), FUTURE_BIRTH_DATE_ERROR),
  );

const emptyToUndefined = z
  .union([z.string(), z.literal("")])
  .optional()
  .transform((val) => (!val || val.trim() === "" ? undefined : val.trim()));

export const mainClientSchema = baseTravelerSchema
  .extend({
    whatsappPhone: phoneSchema,
    email: z.email("Correo electrónico inválido").trim(),
    birthDate: requiredBirthDate,
    boardingPoint: z.string().min(1, "Debes seleccionar en qué punto subirás al autobús"),
  })
  .superRefine(refineTravelerPhones);

const companionSchema = baseTravelerSchema
  .extend({
    id: z.uuid("ID inválido").optional(),
    passengerType: z.enum(["ADULT", "CHILD"]).default("ADULT"),
    whatsappPhone: optionalPhoneSchema,
    email: emptyToUndefined,
    birthDate: requiredBirthDate,
    boardingPoint: z.string().min(1, "Debes seleccionar en qué punto subirás al autobús"),
  })
  .superRefine((data, ctx) => {
    refineTravelerPhones(data, ctx);
    if (data.passengerType === PASSENGER_TYPE.enumValues[0]) {
      if (!data.whatsappPhone) {
        ctx.addIssue({
          code: "custom",
          path: ["whatsappPhone"],
          message: "El WhatsApp es obligatorio para adultos",
        });
      }
      if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        ctx.addIssue({
          code: "custom",
          path: ["email"],
          message: "El correo electrónico es obligatorio para adultos",
        });
      }
    }
  });

export const bookingGroupBodySchema = z.object({
  id: z.uuid("ID inválido").optional(),
  passengerType: z.enum(["ADULT", "CHILD"]).default("ADULT"),
  mainClient: mainClientSchema,
  hasCompanions: z.boolean(),
  companionMethod: z.enum(["MANUAL", "SHARE_LINK"]),
  groupId: z.uuid("El groupId debe ser un UUID válido").optional(),
  companions: z.array(companionSchema),
});

/** Grupo + token del Magic Link (base del registro público). */
export const createBookingBodySchema = bookingGroupBodySchema.extend({
  token: z.string().min(1, "El token es inválido o está vacío").max(255),
});

/**
 * Registro público del Magic Link (decisión del PM, 2026-11-14): la casilla "Acepto el aviso de
 * privacidad" es obligatoria (LFPDPPP; el registro incluye notas médicas, que son datos sensibles).
 */
export const publicRegisterBodySchema = createBookingBodySchema.extend({
  privacyNoticeAccepted: z.literal(true, "Debes aceptar el aviso de privacidad para continuar"),
});

export const newReservationBookingSchema = z
  .object({
    fullName: z.string().trim().min(3, "El nombre es requerido").max(255),
    whatsapp: phoneSchema,
    whatsappCountry: phoneCountrySchema,
    email: z.email("Correo electrónico inválido"),
    numberPassengers: z
      .number()
      .int("Los lugares deben ser un número entero")
      .min(1, "Debe apartar al menos 1 lugar"),
  })
  .superRefine((data, ctx) =>
    refinePhoneCountry(ctx, data.whatsapp, data.whatsappCountry, "whatsapp"),
  );

/** Pre-reserva pública desde el folleto ("Iniciar Reserva"). Sin email: el cliente lo da al registrarse. */
export const publicPreBookingBodySchema = z
  .object({
    tourId: z.uuid("El ID del tour debe ser un UUID válido"),
    fullName: z
      .string()
      .trim()
      .min(3, "El nombre es requerido")
      .max(150, "El nombre es demasiado largo"),
    whatsapp: phoneSchema,
    whatsappCountry: phoneCountrySchema,
    numberPassengers: z
      .number()
      .int("Los lugares deben ser un número entero")
      .min(1, "Debe apartar al menos 1 lugar"),
  })
  .superRefine((data, ctx) =>
    refinePhoneCountry(ctx, data.whatsapp, data.whatsappCountry, "whatsapp"),
  );

export const tourByIdParamsSchema = z.object({
  id: z.uuid("El ID del tour debe ser un UUID válido"),
});

export const cancelBookingParamsSchema = z.object({
  id: z.uuid("ID de reserva inválido"),
});

export const addPassengerToBookingBody = z.object({
  tourId: z.uuid("ID de tour inválido"),
});

export const bookingByIdParamsSchema = z.object({
  bookingId: z.uuid("ID de la reserva inválido"),
});

export const cancelFullBookingBodySchema = z.object({
  penaltyAmount: z.number().min(0, "La penalización no puede ser un valor negativo").default(0),
});

/**
 * Transferencia de un lugar (titular o acompañante) a otra persona.
 * `passengerId` es el `travelerId` que expone el Centro de Control por pasajero.
 * Adultos: WhatsApp (E.164 + país) y correo obligatorios. Menores: WhatsApp opcional, sin correo.
 * El titular siempre es adulto (responsable financiero y dueño del Magic Link).
 */
export const transferPassengerBodySchema = z
  .object({
    passengerId: z.uuid("ID de pasajero inválido"),
    role: z.enum(PASSENGER_ROLES),
    fullName: z
      .string()
      .trim()
      .min(3, "El nombre debe tener al menos 3 caracteres")
      .max(255, "El nombre es demasiado largo"),
    whatsapp: optionalPhoneSchema,
    whatsappCountry: phoneCountrySchema,
    email: emptyToUndefined,
    isMinor: z.boolean().default(false),
    // Solo acompañantes: toma el punto de abordaje del titular en lugar de conservar el del lugar.
    inheritTitularBoardingPoint: z.boolean().default(false),
    // Acordeón opcional "Datos médicos y de emergencia".
    medicalNotes: emptyToUndefined,
    emergencyContactName: emptyToUndefined,
    emergencyContactPhone: optionalPhoneSchema,
    emergencyContactCountry: phoneCountrySchema,
  })
  .superRefine((data, ctx) => {
    if (data.role === PASSENGER_ROLE.TITULAR && data.isMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["isMinor"],
        message: "El titular debe ser un adulto (es el responsable financiero)",
      });
    }
    refinePhoneCountry(ctx, data.whatsapp, data.whatsappCountry, "whatsapp");
    refinePhoneCountry(
      ctx,
      data.emergencyContactPhone,
      data.emergencyContactCountry,
      "emergencyContactPhone",
    );
    if (!data.isMinor) {
      if (data.whatsapp === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["whatsapp"],
          message: "El WhatsApp es obligatorio para adultos",
        });
      }
      if (!data.email || !z.email().safeParse(data.email).success) {
        ctx.addIssue({
          code: "custom",
          path: ["email"],
          message: "El correo electrónico es obligatorio para adultos",
        });
      }
    }
  });

export type TransferPassengerBody = z.infer<typeof transferPassengerBodySchema>;

export type PublicRegisterBody = z.infer<typeof publicRegisterBodySchema>;
export type CreateReservationBookingBody = z.infer<typeof newReservationBookingSchema>;
export type CreatePublicPreBookingBody = z.infer<typeof publicPreBookingBodySchema>;
