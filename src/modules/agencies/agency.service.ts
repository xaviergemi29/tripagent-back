import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies } from "../../db/schema.js";
import type { CreateAgencyBody, UpdateAgencyBody } from "./agency.schema.js";

export class Agency {
  static async createAgency(body: CreateAgencyBody) {
    const trialDay = 30;
    const trialEndsAtDate = new Date();
    trialEndsAtDate.setDate(trialEndsAtDate.getDate() + trialDay);

    const [newAgency] = await db
      .insert(agencies)
      .values({
        ...body,
        trialEndsAt: trialEndsAtDate.toISOString(),
      })
      .returning();

    return newAgency;
  }

  // 🚀 REFACCIÓN: Recibe el ID directamente como string
  static async findAgencyById(agencyId: string) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
    });

    return agency;
  }

  static async updateAgency(agencyId: string, body: UpdateAgencyBody) {
    const [agencyUpdated] = await db
      .update(agencies)
      .set(body)
      .where(eq(agencies.id, agencyId))
      .returning();

    return agencyUpdated;
  }
}
