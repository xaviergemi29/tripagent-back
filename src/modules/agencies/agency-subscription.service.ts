import { and, eq, gte, isNull } from "drizzle-orm";
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
   * Tours activos = no borrados, no cancelados y PRÓXIMO o EN CURSO (salida ≥ ayer en CDMX: misma
   * tolerancia de un día que `getTourTemporalStatus`).
   */
  static async countActiveTours(agencyId: string, now: Date): Promise<number> {
    const yesterdayMX = toMexicoDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    return db.$count(
      tours,
      and(
        eq(tours.agencyId, agencyId),
        isNull(tours.deletedAt),
        isNull(tours.cancelledAt),
        gte(tours.departureDateTime, yesterdayMX),
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
