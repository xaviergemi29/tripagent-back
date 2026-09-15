import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies } from "../../db/schema.js";
import type { CreateAgencyBody, GetAgencyByIdParams, UpdateAgencyBody } from "./agency.schema.js";

export class Agency {
    static async createAgency(body: CreateAgencyBody) {
        const trialDay = 30;
        const trialEndsAtDate = new Date();
        trialEndsAtDate.setDate(trialEndsAtDate.getDate() + trialDay)

        const [newAgency] = await db
            .insert(agencies)
            .values({
                ...body,
                trialEndsAt: trialEndsAtDate.toISOString()
            })
            .returning();

        return newAgency;
    }

    static async findAgencyById(params: GetAgencyByIdParams) {
        const { id } = params;
        const agency = await db
            .query
            .agencies
            .findFirst({
                where: eq(agencies.id, id)
            });

        return agency;
    }

    static async updateAgency(id: string, body: UpdateAgencyBody) {
        const [agencyUpdated] = await db
        .update(agencies)
        .set(body)
        .where(eq(agencies.id, id))
        .returning();

        return agencyUpdated;
    }
}