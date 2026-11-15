import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies } from "../../db/schema.js";
import type { UpdateAgencyBody } from "./agency.schema.js";

/** Agencia de la sesión (perfil público, datos bancarios y políticas). Alta solo por CLI. */
export class Agency {
  static async findAgencyById(agencyId: string) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
    });

    return agency;
  }

  /** Reemplaza las políticas generales de la agencia (`null` = sin políticas). */
  static async updatePolicies(agencyId: string, policies: string | null) {
    const [updated] = await db
      .update(agencies)
      .set({ policies, updatedAt: new Date().toISOString() })
      .where(eq(agencies.id, agencyId))
      .returning({ policies: agencies.policies });

    return updated;
  }

  static async updateAgency(agencyId: string, body: UpdateAgencyBody) {
    const [agencyUpdated] = await db
      .update(agencies)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(eq(agencies.id, agencyId))
      .returning();

    return agencyUpdated;
  }
}
