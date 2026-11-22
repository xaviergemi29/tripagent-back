import { and, count, desc, eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/index.js";
import { notifications } from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import type { NotificationType } from "../../shared/constants/domain.constants.js";

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

  /** Últimas 20 de la agencia (más recientes primero) y el total de no leídas. */
  static async list(agencyId: string) {
    const [items, unread] = await Promise.all([
      db.query.notifications.findMany({
        where: eq(notifications.agencyId, agencyId),
        columns: {
          id: true,
          tourId: true,
          bookingId: true,
          type: true,
          travelerName: true,
          tourTitle: true,
          seatsCount: true,
          isRead: true,
          createdAt: true,
        },
        orderBy: [desc(notifications.createdAt), desc(notifications.id)],
        limit: NOTIFICATIONS_LIMIT,
      }),
      db
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.agencyId, agencyId), eq(notifications.isRead, false))),
    ]);

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
