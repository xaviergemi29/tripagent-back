import { z } from "zod";
import { baseTravelerSchema } from "../travelers/travelers.schema.js";
import { PASSENGER_TYPE } from "../../db/schema.js";
import { PASSENGER_ROLE, PASSENGER_ROLES } from "../../shared/constants/domain.constants.js";

const emptyToUndefined = z
  .union([z.string(), z.literal("")])
  .optional()
  .transform((val) => (!val || val.trim() === "" ? undefined : val.trim()));

export const mainClientSchema = baseTravelerSchema.extend({
  whatsappPhone: z.string().regex(/^(\+)?\d{10}$/, "Debe ser un WhatsApp válido"),
  email: z.email("Correo electrónico inválido").trim(),
  birthDate: emptyToUndefined,
  boardingPoint: z.string().min(1, "Debes seleccionar en qué punto subirás al autobús"),
});

const companionSchema = baseTravelerSchema
  .extend({
    id: z.uuid("ID inválido").optional(),
    passengerType: z.enum(["ADULT", "CHILD"]).default("ADULT"),
    whatsappPhone: emptyToUndefined,
    email: emptyToUndefined,
    birthDate: emptyToUndefined,
    boardingPoint: z.string().min(1, "Debes seleccionar en qué punto subirás al autobús"),
  })
  .superRefine((data, ctx) => {
    if (data.passengerType === PASSENGER_TYPE.enumValues[0]) {
      if (!data.whatsappPhone || !/^(\+)?\d{10}$/.test(data.whatsappPhone)) {
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

export const newReservationBookingSchema = z.object({
  fullName: z.string().trim().min(3, "El nombre es requerido").max(255),
  whatsapp: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10}$/, "Ingresa un número válido"),
  email: z.email("Correo electrónico inválido"),
  numberPassengers: z
    .number()
    .int("Los lugares deben ser un número entero")
    .min(1, "Debe apartar al menos 1 lugar"),
});

/** Pre-reserva pública desde el folleto ("Iniciar Reserva"). Sin email: el cliente lo da al registrarse. */
export const publicPreBookingBodySchema = z.object({
  tourId: z.uuid("El ID del tour debe ser un UUID válido"),
  fullName: z
    .string()
    .trim()
    .min(3, "El nombre es requerido")
    .max(150, "El nombre es demasiado largo"),
  whatsapp: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10}$/, "Ingresa un número válido"),
  numberPassengers: z
    .number()
    .int("Los lugares deben ser un número entero")
    .min(1, "Debe apartar al menos 1 lugar"),
});

export const tourByIdParamsSchema = z.object({
  id: z.uuid("El ID del tour debe ser un UUID válido"),
});

export const cancelBookingParamsSchema = z.object({
  id: z.uuid("ID de reserva inválido"),
});

export const cancelBookingBodySchema = z.object({
  penaltyPercentage: z.number().min(0).max(100).default(0),
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
 * Adultos: WhatsApp (10 dígitos) y correo obligatorios. Menores: WhatsApp opcional, sin correo.
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
    whatsapp: emptyToUndefined,
    email: emptyToUndefined,
    isMinor: z.boolean().default(false),
    // Solo acompañantes: toma el punto de abordaje del titular en lugar de conservar el del lugar.
    inheritTitularBoardingPoint: z.boolean().default(false),
    // Acordeón opcional "Datos médicos y de emergencia".
    medicalNotes: emptyToUndefined,
    emergencyContactName: emptyToUndefined,
    emergencyContactPhone: emptyToUndefined,
  })
  .superRefine((data, ctx) => {
    if (data.role === PASSENGER_ROLE.TITULAR && data.isMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["isMinor"],
        message: "El titular debe ser un adulto (es el responsable financiero)",
      });
    }
    if (data.whatsapp !== undefined && !/^\d{10}$/.test(data.whatsapp)) {
      ctx.addIssue({
        code: "custom",
        path: ["whatsapp"],
        message: "Debe ser un número exactamente a 10 dígitos",
      });
    }
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
    if (data.emergencyContactPhone !== undefined && !/^\d{10}$/.test(data.emergencyContactPhone)) {
      ctx.addIssue({
        code: "custom",
        path: ["emergencyContactPhone"],
        message: "Debe ser un número de emergencia exactamente a 10 dígitos",
      });
    }
  });

export type TransferPassengerBody = z.infer<typeof transferPassengerBodySchema>;

export type PublicRegisterBody = z.infer<typeof publicRegisterBodySchema>;
export type CreateReservationBookingBody = z.infer<typeof newReservationBookingSchema>;
export type CreatePublicPreBookingBody = z.infer<typeof publicPreBookingBodySchema>;
