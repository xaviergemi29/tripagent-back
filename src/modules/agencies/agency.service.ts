import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies } from "../../db/schema.js";
import type { UpdateAgencyBody, UpdateBankAccountBody } from "./agency.schema.js";

/** Agencia de la sesión (perfil público, datos bancarios y políticas). Alta solo por CLI. */
export class Agency {
  static async findAgencyById(agencyId: string) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
    });

    return agency;
  }

  /** Reemplaza las políticas generales de la agencia (`null` = sin políticas). */
  /** Cuenta para transferencias (banco, titular y CLABE), sin tocar el resto del perfil. */
  static async updateBankAccount(agencyId: string, body: UpdateBankAccountBody) {
    const [updated] = await db
      .update(agencies)
      .set({
        bankName: body.bankName,
        bankAccountHolder: body.bankAccountHolder,
        clabeNumber: body.clabeNumber,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agencies.id, agencyId))
      .returning({
        bankName: agencies.bankName,
        bankAccountHolder: agencies.bankAccountHolder,
        clabeNumber: agencies.clabeNumber,
      });

    return updated;
  }

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
      .set({
        ...body,
        // El teléfono siempre viaja en el cuerpo: sin país (cliente anterior) queda sin confirmar.
        phoneCountry: body.phoneCountry ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agencies.id, agencyId))
      .returning();

    return agencyUpdated;
  }
}
