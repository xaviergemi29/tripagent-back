import { z } from "zod";

export const cancelPassengerParamsSchema = z.object({
  bookingId: z.uuid("Id de reserva inválida"),
  travelerId: z.uuid("ID de viajero inválido"),
});

export const cancelPassengerBodySchema = z.object({
  // Retención para la agencia por la baja, en la moneda del tour (0 … precio pactado del lugar; el
  // tope lo valida el servicio con el precio de la reserva → 400). FLUJO-RES-004 / PQ-C5.
  penaltyAmount: z
    .number("La retención debe ser un número")
    .min(0, "La retención no puede ser negativa")
    .default(0),
});
