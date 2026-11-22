import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/index.js";
import { bookings, magicTokens, notifications, tours, travelers } from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import type { NotificationType } from "../../shared/constants/domain.constants.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  type BookingStatus,
} from "../../shared/utils/booking-rules.util.js";

/** El popover del panel muestra las últimas 20 (no hay página de historial en el MVP). */
export const NOTIFICATIONS_LIMIT = 20;

/** Datos del aviso; los escribe el flujo público dentro de su propia transacción. */
interface CreateNotificationInput {
  agencyId: string;
  tourId: string;
  bookingId: string;
  type: NotificationType;
  travelerName: string;
  tourTitle: string;
  seatsCount: number;
}

type Currency = (typeof tours.$inferSelect)["currency"];

/** Columnas vivas de la reserva que trae el LEFT JOIN (todas nulas si la reserva no existe). */
export interface NotificationBookingRow {
  bookingStatus: BookingStatus | null;
  bookingTotalPrice: number | null;
  bookingAmountPaid: number | null;
  tourPrice: number | null;
  tourDepositPerPerson: number | null;
  tourCurrency: Currency | null;
  titularWhatsappPhone: string | null;
  magicToken: string | null;
  magicTokenPassengers: number | null;
}

/** Estado ACTUAL de la reserva del aviso (a diferencia de `travelerName`/`tourTitle`, que son foto). */
export interface NotificationBooking {
  status: BookingStatus;
  whatsappPhone: string | null;
  magicToken: string | null;
  pendingDeposit: number;
  currency: Currency;
}

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

/**
 * Arma el `booking` del aviso. `null` si la reserva ya no existe, está borrada o no es de la agencia
 * (el JOIN no la trajo). El anticipo pendiente usa la MISMA regla que el dashboard
 * (`getExpectedGroupSize` + `getRequiredDeposit`) y nunca es negativo.
 */
export function toNotificationBooking(row: NotificationBookingRow): NotificationBooking | null {
  if (row.bookingStatus === null || row.tourCurrency === null) return null;

  const amountPaid = Number(row.bookingAmountPaid ?? 0);
  const groupSize = getExpectedGroupSize(
    row.magicTokenPassengers,
    Number(row.bookingTotalPrice ?? 0),
    Number(row.tourPrice ?? 0),
  );
  const requiredDeposit = getRequiredDeposit(Number(row.tourDepositPerPerson ?? 0), groupSize);

  return {
    status: row.bookingStatus,
    whatsappPhone: row.titularWhatsappPhone || null,
    magicToken: row.magicToken,
    pendingDeposit: roundToCents(Math.max(0, requiredDeposit - amountPaid)),
    currency: row.tourCurrency,
  };
}

/**
 * Notificaciones in-app de la agencia (2026-11-22). Solo las crean la pre-reserva del folleto y el
 * registro del Magic Link (regla anti-ruido). `isRead` es compartido por la agencia.
 */
export class NotificationService {
  /**
   * Inserta el aviso con la `tx` del flujo que lo dispara: si la reserva o el registro se revierten,
   * el aviso tampoco existe. Los textos se recortan al largo de la columna (son una foto).
   */
  static async create(tx: DbTransaction, data: CreateNotificationInput): Promise<void> {
    await tx.insert(notifications).values({
      agencyId: data.agencyId,
      tourId: data.tourId,
      bookingId: data.bookingId,
      type: data.type,
      travelerName: data.travelerName.trim().slice(0, 120),
      tourTitle: data.tourTitle.trim().slice(0, 160),
      seatsCount: data.seatsCount,
    });
  }

  /**
   * Últimas 20 de la agencia (más recientes primero) y el total de no leídas. Cada aviso trae
   * `booking` con datos VIVOS de la reserva (estado, WhatsApp del titular actual, Magic Link y
   * anticipo pendiente) en la misma consulta (LEFT JOIN, sin N+1). Cada JOIN filtra también por la
   * agencia de la sesión: una reserva ajena nunca se expone, aunque el aviso apuntara a ella.
   */
  static async list(agencyId: string) {
    const [rows, unread] = await Promise.all([
      db
        .select({
          id: notifications.id,
          tourId: notifications.tourId,
          bookingId: notifications.bookingId,
          type: notifications.type,
          travelerName: notifications.travelerName,
          tourTitle: notifications.tourTitle,
          seatsCount: notifications.seatsCount,
          isRead: notifications.isRead,
          createdAt: notifications.createdAt,
          bookingStatus: bookings.status,
          bookingTotalPrice: bookings.totalPrice,
          bookingAmountPaid: bookings.amountPaid,
          tourPrice: tours.price,
          tourDepositPerPerson: tours.depositPerPerson,
          tourCurrency: tours.currency,
          titularWhatsappPhone: travelers.whatsappPhone,
          magicToken: magicTokens.token,
          magicTokenPassengers: magicTokens.numberPassengers,
        })
        .from(notifications)
        .leftJoin(
          bookings,
          and(
            eq(bookings.id, notifications.bookingId),
            eq(bookings.agencyId, agencyId),
            isNull(bookings.deletedAt),
          ),
        )
        .leftJoin(tours, and(eq(tours.id, bookings.tourId), eq(tours.agencyId, agencyId)))
        .leftJoin(
          travelers,
          and(eq(travelers.id, bookings.travelerId), eq(travelers.agencyId, agencyId)),
        )
        .leftJoin(
          magicTokens,
          and(eq(magicTokens.bookingId, bookings.id), eq(magicTokens.agencyId, agencyId)),
        )
        .where(eq(notifications.agencyId, agencyId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(NOTIFICATIONS_LIMIT),
      db
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.agencyId, agencyId), eq(notifications.isRead, false))),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      tourId: row.tourId,
      bookingId: row.bookingId,
      type: row.type,
      travelerName: row.travelerName,
      tourTitle: row.tourTitle,
      seatsCount: row.seatsCount,
      isRead: row.isRead,
      createdAt: row.createdAt,
      booking: toNotificationBooking(row),
    }));

    return { items, unreadCount: Number(unread[0]?.value ?? 0) };
  }

  /** Marca una como leída para toda la agencia. Ajena o inexistente → 404. Idempotente. */
  static async markAsRead(id: string, agencyId: string) {
    const [updated] = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.agencyId, agencyId)))
      .returning({ id: notifications.id, isRead: notifications.isRead });

    if (!updated) throw new NotFoundError("Notificación no encontrada");
    return updated;
  }

  /** Marca como leídas todas las pendientes de la agencia. Devuelve cuántas cambiaron. */
  static async markAllAsRead(agencyId: string) {
    const updated = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.agencyId, agencyId), eq(notifications.isRead, false)))
      .returning({ id: notifications.id });

    return { updatedCount: updated.length };
  }
}
