/**
 * Sincroniza el catálogo versionado (src/db/catalog/vehicle-templates.catalog.ts) con la tabla
 * `vehicle_templates`. Idempotente: se puede ejecutar las veces que haga falta.
 *
 *   npm run vehicle-templates:sync
 *
 * - `code` nuevo → INSERT.
 * - `code` existente con el mismo croquis → actualiza nombre, descripción, orden y `isActive`.
 * - `code` existente con OTRO croquis → error y rollback: las plantillas son inmutables (las
 *   agencias ya copiaron el croquis y sus tours tienen asientos con esas etiquetas).
 */
import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { vehicleTemplates } from "./schema.js";
import { VEHICLE_TEMPLATE_CATALOG } from "./catalog/vehicle-templates.catalog.js";
import { getVehicleCapacity, layoutMapSchema } from "../shared/utils/vehicle-layout.util.js";

/** JSON con llaves ordenadas: jsonb no conserva el orden de las llaves de los objetos. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
      : val,
  );

async function syncVehicleTemplates() {
  const summary = await db.transaction(async (tx) => {
    const rows = [];
    for (const definition of VEHICLE_TEMPLATE_CATALOG) {
      const layoutMap = layoutMapSchema.parse(definition.layoutMap);
      const capacity = getVehicleCapacity(layoutMap);

      const existing = await tx.query.vehicleTemplates.findFirst({
        where: eq(vehicleTemplates.code, definition.code),
      });

      if (!existing) {
        await tx.insert(vehicleTemplates).values({
          code: definition.code,
          name: definition.name,
          description: definition.description,
          layoutMap,
          isActive: definition.isActive,
          sortOrder: definition.sortOrder,
        });
        rows.push({ code: definition.code, action: "creada", ...capacity });
        continue;
      }

      if (canonical(existing.layoutMap) !== canonical(layoutMap)) {
        throw new Error(
          `La plantilla ${definition.code} ya existe con otro croquis. Las plantillas son inmutables: crea un code nuevo y desactiva la anterior.`,
        );
      }

      await tx
        .update(vehicleTemplates)
        .set({
          name: definition.name,
          description: definition.description,
          isActive: definition.isActive,
          sortOrder: definition.sortOrder,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(vehicleTemplates.id, existing.id));
      rows.push({ code: definition.code, action: "sin cambios de croquis", ...capacity });
    }
    return rows;
  });

  console.table(summary);
}

syncVehicleTemplates()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ No se sincronizó el catálogo (rollback):", error);
    process.exit(1);
  });
