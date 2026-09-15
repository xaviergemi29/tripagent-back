import { z } from "zod";
import { PASSENGER_TYPE } from "../../db/schema.js";

export const cancelPassengerParamsSchema = z.object({
    bookingId: z.uuid("Id de reserva inválida"),
    travelerId: z.uuid("ID de viajero inválido"),
});

export const cancelPassengerBodySchema = z.object({
    // Recibimos directamente pesos mexicanos (MXN)
    penaltyAmount: z.number().min(0).default(0),
});

export const addPassengerParamsSchema = z.object({
    bookingId: z.uuid("Id de reserva inválida"),
});

export const addPassengerBodySchema = z.object({
    travelerId: z.uuid("ID de viajero inválido"),
    passengerType: z.enum(PASSENGER_TYPE.enumValues).default("ADULT"),
    boardingPoint: z.string().min(1, "El punto de abordaje es requerido"),
});

export type CancelPassengerParams = z.infer<typeof cancelPassengerParamsSchema>;
export type CancelPassengerBody = z.infer<typeof cancelPassengerBodySchema>;
export type AddPassengerBody = z.infer<typeof addPassengerBodySchema>;
