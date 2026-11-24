import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies, tours, travelers } from "../../db/schema.js";
import { ConflictError, NotFoundError } from "../../shared/errors/domain-errors.js";
import type { SubscriptionCancellationReason } from "../../shared/constants/domain.constants.js";
import {
  SUBSCRIPTION_PLAN,
  buildSpeiReference,
  computeTrialProgress,
  isAgencyReadOnly,
  isPeriodExpired,
  isSubscriptionReadOnly,
  resolveSubscriptionPeriodEnd,
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

  /**
   * Modo Solo Lectura de la agencia (candado de `app.authenticate` en las mutaciones). Una agencia
   * inexistente se trata como en solo lectura: falla cerrado.
   */
  static async isReadOnly(agencyId: string, now: Date = new Date()): Promise<boolean> {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
      columns: {
        subscriptionStatus: true,
        trialEndsAt: true,
        createdAt: true,
        subscriptionPeriodEndsAt: true,
      },
    });
    return agency ? isAgencyReadOnly(agency, now) : true;
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
        subscriptionPeriodEndsAt: true,
        subscriptionCanceledAt: true,
        subscriptionCancellationReason: true,
        subscriptionCancellationComment: true,
      },
    });
    if (!agency) return null;

    const [activeToursCount, registeredTravelersCount] = await Promise.all([
      AgencySubscriptionService.countActiveTours(agencyId, now),
      AgencySubscriptionService.countTravelers(agencyId),
    ]);

    const trialEndsAt = resolveTrialEndsAt(agency.trialEndsAt, agency.createdAt);
    const trialProgress = computeTrialProgress(trialEndsAt, now);

    return {
      status: agency.subscriptionStatus,
      ...trialProgress,
      // Modo Solo Lectura (2026-11-18): el front lo usa tal cual, sin recalcular la regla.
      isReadOnly: isSubscriptionReadOnly(
        agency.subscriptionStatus,
        trialProgress.trialExpired,
        isPeriodExpired(agency.subscriptionPeriodEndsAt, now),
      ),
      trialEndsAt,
      // Fin del periodo pagado (plan activo o baja programada): el registrado o, sin fecha, el fin
      // del mes en curso. En prueba o con el plan vencido no aplica.
      currentPeriodEndsAt:
        agency.subscriptionStatus === "active" || agency.subscriptionStatus === "cancel_scheduled"
          ? resolveSubscriptionPeriodEnd(agency.subscriptionPeriodEndsAt, now)
          : null,
      cancellation:
        agency.subscriptionStatus === "cancel_scheduled"
          ? {
              canceledAt: agency.subscriptionCanceledAt,
              reason: agency.subscriptionCancellationReason,
              comment: agency.subscriptionCancellationComment,
            }
          : null,
      priceMxn: SUBSCRIPTION_PLAN.priceMxn,
      metrics: { activeToursCount, registeredTravelersCount },
      speiDetails: billing.spei
        ? { ...billing.spei, reference: buildSpeiReference(agency.name, agency.id) }
        : null,
      stripePaymentLink: billing.stripePaymentLink,
      whatsappSupportNumber: billing.whatsappSupportNumber,
    };
  }

  /**
   * Baja programada de la suscripción (cobro por transferencia, 2026-11-23). Solo con el plan
   * activo y sin otra baja en curso (409). No corta el acceso: la agencia opera normal hasta la
   * fecha de corte (la registrada o el fin del mes en curso) y después pasa a Modo Solo Lectura
   * (`isSubscriptionReadOnly`), sin borrar datos. Devuelve lo necesario para avisar a TripAgent.
   */
  static async cancelSubscription(
    agencyId: string,
    input: { reason: SubscriptionCancellationReason; comments?: string | undefined },
    now: Date = new Date(),
  ) {
    return db.transaction(async (tx) => {
      const [agency] = await tx
        .select({
          name: agencies.name,
          subscriptionStatus: agencies.subscriptionStatus,
          subscriptionPeriodEndsAt: agencies.subscriptionPeriodEndsAt,
        })
        .from(agencies)
        .where(and(eq(agencies.id, agencyId), isNull(agencies.deletedAt)))
        .for("update");
      if (!agency) throw new NotFoundError("Agencia no encontrada");
      if (agency.subscriptionStatus === "cancel_scheduled") {
        throw new ConflictError("Tu suscripción ya tiene una cancelación programada.");
      }
      if (agency.subscriptionStatus !== "active") {
        throw new ConflictError("Solo se puede cancelar una suscripción activa.");
      }

      const periodEndsAt = resolveSubscriptionPeriodEnd(agency.subscriptionPeriodEndsAt, now);
      const canceledAt = now.toISOString();
      const comment = input.comments?.trim() || null;
      await tx
        .update(agencies)
        .set({
          subscriptionStatus: "cancel_scheduled",
          subscriptionPeriodEndsAt: periodEndsAt,
          subscriptionCanceledAt: canceledAt,
          subscriptionCancellationReason: input.reason,
          subscriptionCancellationComment: comment,
          updatedAt: canceledAt,
        })
        .where(eq(agencies.id, agencyId));

      return {
        agencyName: agency.name,
        status: "cancel_scheduled" as const,
        currentPeriodEndsAt: periodEndsAt,
        canceledAt,
        reason: input.reason,
        comment,
      };
    });
  }

  /**
   * Reactivar antes de la fecha de corte: el plan vuelve a `active` y se borra la baja. Pasada la
   * fecha (409) la agencia reactiva pagando, como cualquier plan vencido.
   */
  static async reactivateSubscription(agencyId: string, now: Date = new Date()) {
    return db.transaction(async (tx) => {
      const [agency] = await tx
        .select({
          name: agencies.name,
          subscriptionStatus: agencies.subscriptionStatus,
          subscriptionPeriodEndsAt: agencies.subscriptionPeriodEndsAt,
        })
        .from(agencies)
        .where(and(eq(agencies.id, agencyId), isNull(agencies.deletedAt)))
        .for("update");
      if (!agency) throw new NotFoundError("Agencia no encontrada");
      if (agency.subscriptionStatus !== "cancel_scheduled") {
        throw new ConflictError("Tu suscripción no tiene una cancelación programada.");
      }
      if (isPeriodExpired(agency.subscriptionPeriodEndsAt, now)) {
        throw new ConflictError(
          "La fecha de corte ya pasó: para reactivar tu plan, realiza tu pago desde esta pestaña.",
        );
      }

      await tx
        .update(agencies)
        .set({
          subscriptionStatus: "active",
          subscriptionCanceledAt: null,
          subscriptionCancellationReason: null,
          subscriptionCancellationComment: null,
          updatedAt: now.toISOString(),
        })
        .where(eq(agencies.id, agencyId));

      return {
        agencyName: agency.name,
        status: "active" as const,
        currentPeriodEndsAt: resolveSubscriptionPeriodEnd(agency.subscriptionPeriodEndsAt, now),
      };
    });
  }
}
