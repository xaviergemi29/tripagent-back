import { desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreateVehicleBody } from "./vehicles.schema.js";
import { vehicles } from "../../db/schema.js";

export class VehiclesService {
  static async getAllVehicles() {
    return await db.query.vehicles.findMany({
      orderBy: [desc(vehicles.id)],
    });
  }

  static async createVehicle(data: CreateVehicleBody) {
    const [newVehicle] = await db
      .insert(vehicles)
      .values({
        name: data.name,
        layoutMap: data.layoutMap as string[][],
      })
      .returning();

    return newVehicle;
  }
}
