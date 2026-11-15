import z from "zod";

export const getTourSeatsByIdParamSchema = z.object({ tourId: z.uuid() });
// La etiqueta del asiento es `varchar(10)` en BD: más larga respondía un 500.
export const updateTourSeatsParamsSchema = z.object({
  tourId: z.uuid(),
  seatLabel: z.string().trim().min(1).max(10),
});
export const updateSeatBodySchema = z.object({
  status: z.enum(["AVAILABLE", "ASSIGNED", "BLOCKED"]),
  passengerId: z.uuid().nullable().optional().default(""),
});

export type UpdateSeatBody = z.infer<typeof updateSeatBodySchema>;
