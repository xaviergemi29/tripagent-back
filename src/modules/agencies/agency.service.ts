import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies } from "../../db/schema.js";
import type { UpdateAgencyBody } from "./agency.schema.js";

/**
 * Agencia de la sesión (perfil público y políticas). Las cuentas bancarias viven en
 * `agency_bank_accounts` (`AgencyBankAccountService`): las columnas bancarias heredadas de
 * `agencies` ya no se leen ni se escriben.
 */
export class Agency {
  static async findAgencyById(agencyId: string) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
      columns: {
        id: true,
        name: true,
        phone: true,
        phoneCountry: true,
        email: true,
        address: true,
        logoPath: true,
        privacyNoticeUrl: true,
        policies: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        subscriptionPeriodEndsAt: true,
        subscriptionCanceledAt: true,
        subscriptionCancellationReason: true,
        subscriptionCancellationComment: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
      with: {
        bankAccounts: {
          columns: {
            id: true,
            bankName: true,
            accountHolder: true,
            clabeNumber: true,
            cardNumber: true,
            position: true,
          },
          orderBy: (account, { asc }) => [asc(account.position), asc(account.id)],
        },
      },
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

  /** Perfil de la agencia (sin datos bancarios ni suscripción: Zod los descarta). */
  static async updateAgency(agencyId: string, body: UpdateAgencyBody) {
    const [agencyUpdated] = await db
      .update(agencies)
      .set({
        name: body.name,
        phone: body.phone,
        // El teléfono siempre viaja en el cuerpo: sin país (cliente anterior) queda sin confirmar.
        phoneCountry: body.phoneCountry ?? null,
        email: body.email,
        ...(body.address !== undefined && { address: body.address }),
        ...(body.privacyNoticeUrl !== undefined && { privacyNoticeUrl: body.privacyNoticeUrl }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agencies.id, agencyId))
      .returning({
        id: agencies.id,
        name: agencies.name,
        phone: agencies.phone,
        phoneCountry: agencies.phoneCountry,
        email: agencies.email,
        address: agencies.address,
        logoPath: agencies.logoPath,
        privacyNoticeUrl: agencies.privacyNoticeUrl,
        policies: agencies.policies,
        subscriptionStatus: agencies.subscriptionStatus,
        trialEndsAt: agencies.trialEndsAt,
        subscriptionPeriodEndsAt: agencies.subscriptionPeriodEndsAt,
        subscriptionCanceledAt: agencies.subscriptionCanceledAt,
        subscriptionCancellationReason: agencies.subscriptionCancellationReason,
        subscriptionCancellationComment: agencies.subscriptionCancellationComment,
        isActive: agencies.isActive,
        createdAt: agencies.createdAt,
        updatedAt: agencies.updatedAt,
        deletedAt: agencies.deletedAt,
      });

    return agencyUpdated;
  }
}
