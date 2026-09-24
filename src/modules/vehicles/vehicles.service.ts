import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreateVehicleBody } from "./vehicles.schema.js";
import { vehicles } from "../../db/schema.js";

export class VehiclesService {
  static async getAllVehicles(agencyId: string) {
    return await db.query.vehicles.findMany({
      where: eq(vehicles.agencyId, agencyId),
      orderBy: [desc(vehicles.createdAt)],
    });
  }

  static async createVehicle(data: CreateVehicleBody, agencyId: string) {
    const [newVehicle] = await db
      .insert(vehicles)
      .values({
        agencyId,
        name: data.name,
        layoutMap: data.layoutMap,
      })
      .returning();

    return newVehicle;
  }
}
