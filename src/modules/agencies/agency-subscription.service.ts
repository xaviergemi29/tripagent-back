import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies, tours, travelers } from "../../db/schema.js";
import {
  SUBSCRIPTION_PLAN,
  buildSpeiReference,
  computeTrialProgress,
  resolveSubscriptionBillingConfig,
  resolveTrialEndsAt,
  toMexicoDate,
  type SubscriptionBillingConfig,
} from "../../shared/utils/subscription.util.js";

/**
 * Suscripción de la agencia (`GET /agencies/subscription`): estado, consumo de la prueba, métricas
 * de uso y canales de pago de TripAgent. Es de solo lectura: el estado lo administra TripAgent
 * (no hay webhook de Stripe; la activación es manual).
 */
export class AgencySubscriptionService {
  /**
   * Tours activos = no borrados, no cancelados y PRÓXIMO o EN CURSO: su último día en curso
   * (regreso válido, o salida + 1 sin regreso; misma regla que `getTourLastActiveDate`) es hoy o
   * después, en hora de CDMX.
   */
  static async countActiveTours(agencyId: string, now: Date): Promise<number> {
    const todayMX = toMexicoDate(now);
    return db.$count(
      tours,
      and(
        eq(tours.agencyId, agencyId),
        isNull(tours.deletedAt),
        isNull(tours.cancelledAt),
        sql`(CASE WHEN ${tours.returnDate} >= ${tours.departureDateTime} THEN ${tours.returnDate} ELSE ${tours.departureDateTime} + 1 END) >= ${todayMX}::date`,
      ),
    );
  }

  /** Viajeros del CRM de la agencia (no borrados). */
  static async countTravelers(agencyId: string): Promise<number> {
    return db.$count(travelers, and(eq(travelers.agencyId, agencyId), isNull(travelers.deletedAt)));
  }

  static async getSubscription(
    agencyId: string,
    now: Date = new Date(),
    billing: SubscriptionBillingConfig = resolveSubscriptionBillingConfig(),
  ) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
      columns: {
        id: true,
        name: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        createdAt: true,
      },
    });
    if (!agency) return null;

    const [activeToursCount, registeredTravelersCount] = await Promise.all([
      AgencySubscriptionService.countActiveTours(agencyId, now),
      AgencySubscriptionService.countTravelers(agencyId),
    ]);

    const trialEndsAt = resolveTrialEndsAt(agency.trialEndsAt, agency.createdAt);

    return {
      status: agency.subscriptionStatus,
      ...computeTrialProgress(trialEndsAt, now),
      trialEndsAt,
      priceMxn: SUBSCRIPTION_PLAN.priceMxn,
      metrics: { activeToursCount, registeredTravelersCount },
      speiDetails: billing.spei
        ? { ...billing.spei, reference: buildSpeiReference(agency.name, agency.id) }
        : null,
      stripePaymentLink: billing.stripePaymentLink,
      whatsappSupportNumber: billing.whatsappSupportNumber,
    };
  }
}
