import { z } from "zod";

export const createVehicleBodySchema = z.object({
  name: z.string().trim().min(3, "El nombre debe tener al menos 3 caracteres"),
  layoutMap: z.array(z.array(z.string().nullable())),
});

export type CreateVehicleBody = z.infer<typeof createVehicleBodySchema>;
