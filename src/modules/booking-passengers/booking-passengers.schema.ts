import { z } from "zod";

export const cancelPassengerParamsSchema = z.object({
  bookingId: z.uuid("Id de reserva inválida"),
  travelerId: z.uuid("ID de viajero inválido"),
});

export const cancelPassengerBodySchema = z.object({
  // Recibimos directamente pesos mexicanos (MXN)
  penaltyAmount: z.number().min(0).default(0),
});
