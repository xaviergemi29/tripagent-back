import { ilike, or, count, desc, eq, and, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies, bookings, travelers } from "../../db/schema.js";
import type {
  GetTravelersQuery,
  UpdateTravelerBody,
  CreateTravelerBody,
} from "./travelers.schema.js";

export class TravelerService {
  static async creteTraveler(body: CreateTravelerBody, agencyId: string) {
    const [createdTraveler] = await db
      .insert(travelers)
      .values({ ...body, agencyId })
      .returning();

    return createdTraveler;
  }

  static async findTravelers(query: GetTravelersQuery, agencyId: string) {
    const { search, limit, offset } = query;

    const searchCondition = search
      ? or(
          ilike(travelers.fullName, `%${search}%`),
          ilike(travelers.email, `%${search}%`),
          ilike(travelers.whatsappPhone, `%${search}%`),
        )
      : undefined;

    const whereClause = and(
      eq(travelers.agencyId, agencyId),
      isNull(travelers.deletedAt),
      searchCondition,
    );

    const data = await db
      .select()
      .from(travelers)
      .where(whereClause)
      .orderBy(desc(travelers.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(travelers)
      .where(whereClause);

    return {
      data,
      pagination: {
        total: Number(total),
        limit,
        offset,
        hasMore: offset + data.length < Number(total),
      },
    };
  }

  /**
   * Obtiene un viajero por su ID único (UUID).
   * Retorna la entidad o `undefined` si no existe en la BD.
   */
  static async findTravelerById(id: string, agencyId: string) {
    const traveler = await db.query.travelers.findFirst({
      where: and(
        eq(travelers.id, id),
        eq(travelers.agencyId, agencyId),
        isNull(travelers.deletedAt),
      ),
    });
    return traveler;
  }

  /**
   * Actualiza parcialmente un viajero y retorna la entidad modificada.
   * Ejecuta una sola consulta atómica usando la cláusula RETURNING de PostgreSQL.
   */
  static async updateTraveler(id: string, params: UpdateTravelerBody, agencyId: string) {
    const [updatedTraveler] = await db
      .update(travelers)
      .set({ ...params })
      .where(
        and(eq(travelers.id, id), eq(travelers.agencyId, agencyId), isNull(travelers.deletedAt)),
      )
      .returning();
    return updatedTraveler;
  }

  static async softDeleteTraveler(id: string, agencyId: string) {
    const [travelerDeleted] = await db
      .update(travelers)
      .set({ deletedAt: new Date().toISOString() })
      .where(
        and(
          eq(travelers.id, id),
          and(eq(travelers.agencyId, agencyId)),
          isNull(travelers.deletedAt),
        ),
      )
      .returning();

    return travelerDeleted;
  }

  /**
   * Elimina físicamente un viajero por su ID (UUID).
   * Ejecuta una sola consulta SQL utilizando la cláusula RETURNING de PostgreSQL.
   * Retorna la entidad eliminada o `undefined` si no existía.
   */
  static async deleteTraveler(id: string) {
    const [travelerDeleted] = await db.delete(travelers).where(eq(travelers.id, id)).returning();

    return travelerDeleted;
  }

  static async getTravelerHistory(travelerId: string, agencyId: string) {
    // 1. Traemos al viajero con sus reservas y tours anidados gracias a tus relations()
    const traveler = await db.query.travelers.findFirst({
      where: and(
        eq(travelers.agencyId, agencyId),
        eq(travelers.id, travelerId),
        isNull(travelers.deletedAt),
      ),
      with: {
        bookings: {
          // Excluimos las canceladas para las métricas de valor real
          where: ne(bookings.status, "CANCELLED"),
          orderBy: (bookings, { desc }) => [desc(bookings.createdAt)],
          with: {
            tour: {
              columns: {
                title: true,
                departureDateTime: true,
              },
            },
          },
        },
      },
    });

    if (!traveler) return null;

    // 2. Calculamos las métricas en memoria (O(1) ya que los arrays de un solo usuario son pequeños)
    const totalTrips = traveler.bookings.length;
    const lifetimeValue = traveler.bookings.reduce(
      (sum, booking) => sum + Number(booking.amountPaid),
      0,
    );
    return {
      ...traveler,
      metrics: {
        totalTrips,
        lifetimeValue,
      },
    };
  }
}
