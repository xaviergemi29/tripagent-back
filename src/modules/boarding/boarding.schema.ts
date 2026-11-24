import { z } from "zod";

/** Cuerpo de las dos rutas de pase de lista (panel y enlace de staff). */
export const setBoardingBodySchema = z.object({
  boarded: z.boolean("Indica si el pasajero abordó"),
});

export const boardingTourParamsSchema = z.object({
  tourId: z.uuid("ID de tour inválido"),
});

export const boardingPassengerParamsSchema = z.object({
  tourId: z.uuid("ID de tour inválido"),
  travelerId: z.uuid("ID de pasajero inválido"),
});

/** El formato del token y de la clave se valida en el servicio (404 único, sin oráculo). */
export const publicBoardingParamsSchema = z.object({
  token: z.string().max(64),
});

export const publicBoardingPassengerParamsSchema = z.object({
  token: z.string().max(64),
  boardingKey: z.string().max(64),
});
