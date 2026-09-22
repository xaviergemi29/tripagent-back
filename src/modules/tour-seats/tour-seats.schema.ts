import z from "zod";

export const getTourSeatsByIdParamSchema = z.object({ tourId: z.uuid() });
export const updateTourSeatsParamsSchema = z.object({ tourId: z.uuid(), seatLabel: z.string() });
export const updateSeatBodySchema = z.object({
  status: z.enum(["AVAILABLE", "ASSIGNED", "BLOCKED"]),
  passengerId: z.uuid().nullable().optional().default(""),
});

export type UpdateTravelerBody = z.infer<typeof updateTourSeatsParamsSchema>;
