import { z } from "zod";
import { layoutMapSchema } from "../../shared/utils/vehicle-layout.util.js";

export const createVehicleBodySchema = z.object({
  name: z.string().trim().min(3, "El nombre debe tener al menos 3 caracteres").max(100),
  // Acepta el formato de celdas tipadas (SEAT/DRIVER/WC) y el anterior (texto, "AISLE", null).
  layoutMap: layoutMapSchema,
});

export type CreateVehicleBody = z.infer<typeof createVehicleBodySchema>;
