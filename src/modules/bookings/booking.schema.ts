import { z } from "zod";
import { baseTravelerSchema } from "../travelers/travelers.schema.js";
import { PASSENGER_TYPE } from "../../db/schema.js";

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

export const createBookingBodySchema = bookingGroupBodySchema.extend({
  token: z.string().min(1, "El token es inválido o está vacío"),
});

export const newReservationBookingSchema = z.object({
  fullName: z.string().trim().min(3, "El nombre es requerido"),
  whatsapp: z
    .string()
    .trim()
    .regex(/^(\+)?\d{10}$/, "Ingresa un número válido"),
  email: z.email("Correo electrónico inválido"),
  numberPassengers: z.number().min(1, "Debe apartar al menos 1 lugar"),
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

export type CancelFullBookingBody = z.infer<typeof cancelFullBookingBodySchema>;
export type CancelBookingParams = z.infer<typeof cancelBookingParamsSchema>;
export type CancelBookingBody = z.infer<typeof cancelBookingBodySchema>;
export type AddPassengerToBookingBody = z.infer<typeof addPassengerToBookingBody>;
export type BookingByIdParamsSchema = z.infer<typeof bookingByIdParamsSchema>;
export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;
export type RegisterGroupBody = z.infer<typeof bookingGroupBodySchema>;
export type CreateReservationBookingBody = z.infer<typeof newReservationBookingSchema>;
