import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { vehicles } from "../../db/schema.js";
import { getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";

export class VehiclesService {
  /** Unidades de la agencia con su capacidad calculada (operador excluido; staff aparte). */
  static async getAllVehicles(agencyId: string) {
    const agencyVehicles = await db.query.vehicles.findMany({
      where: eq(vehicles.agencyId, agencyId),
      columns: { id: true, templateId: true, name: true, layoutMap: true, createdAt: true },
      orderBy: [desc(vehicles.createdAt)],
    });

    return agencyVehicles.map((vehicle) => ({
      id: vehicle.id,
      templateId: vehicle.templateId,
      name: vehicle.name,
      layoutMap: vehicle.layoutMap,
      capacity: getVehicleCapacity(vehicle.layoutMap),
      createdAt: vehicle.createdAt,
    }));
  }
}
