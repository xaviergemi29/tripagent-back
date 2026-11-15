import { and, asc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "../../db/index.js";
import { vehicleTemplates, vehicles } from "../../db/schema.js";
import { getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";

/**
 * Catálogo global de plantillas (lectura) e instanciación de una plantilla como unidad de la
 * agencia. La copia del croquis protege los asientos de tours existentes si el catálogo crece.
 */
export class VehicleTemplatesService {
  /** Plantillas activas del catálogo, en el orden definido por TripAgent. */
  static async findActiveTemplates() {
    const templates = await db.query.vehicleTemplates.findMany({
      where: eq(vehicleTemplates.isActive, true),
      columns: { id: true, code: true, name: true, description: true, layoutMap: true },
      orderBy: [asc(vehicleTemplates.sortOrder), asc(vehicleTemplates.name)],
    });

    return templates.map((template) => ({
      id: template.id,
      code: template.code,
      name: template.name,
      description: template.description,
      layoutMap: template.layoutMap,
      capacity: getVehicleCapacity(template.layoutMap),
    }));
  }

  /**
   * Devuelve la unidad de la agencia creada a partir de la plantilla; si no existe, la crea
   * copiando nombre y croquis. Debe llamarse dentro de una transacción.
   * Lanza "Plantilla de vehículo no encontrada" (→ 404) si la plantilla no existe o está inactiva.
   */
  static async findOrCreateAgencyVehicle(
    executor: DbExecutor,
    templateId: string,
    agencyId: string,
  ) {
    const existing = await executor.query.vehicles.findFirst({
      where: and(eq(vehicles.agencyId, agencyId), eq(vehicles.templateId, templateId)),
      columns: { id: true, layoutMap: true },
    });
    if (existing) return existing;

    const template = await executor.query.vehicleTemplates.findFirst({
      where: and(eq(vehicleTemplates.id, templateId), eq(vehicleTemplates.isActive, true)),
      columns: { id: true, name: true, layoutMap: true },
    });
    if (!template) throw new NotFoundError("Plantilla de vehículo no encontrada");

    // ON CONFLICT: otra petición simultánea pudo crear la misma unidad (índice único parcial).
    const [created] = await executor
      .insert(vehicles)
      .values({
        agencyId,
        templateId: template.id,
        name: template.name,
        layoutMap: template.layoutMap,
      })
      .onConflictDoNothing()
      .returning({ id: vehicles.id, layoutMap: vehicles.layoutMap });
    if (created) return created;

    const concurrent = await executor.query.vehicles.findFirst({
      where: and(eq(vehicles.agencyId, agencyId), eq(vehicles.templateId, templateId)),
      columns: { id: true, layoutMap: true },
    });
    if (!concurrent) throw new NotFoundError("Plantilla de vehículo no encontrada");
    return concurrent;
  }
}
