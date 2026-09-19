import { ilike, or, count, desc, eq, and, isNull, ne, sql, getTableColumns } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingPassengers, bookings, tours, travelers } from "../../db/schema.js";
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
      .select({
        ...getTableColumns(travelers),

        tripCount: sql<number>`(
          SELECT count(*)::int
          FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
        )`.mapWith(Number),
      })
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
    // 1. Validar existencia del viajero
    const traveler = await db.query.travelers.findFirst({
      where: and(
        eq(travelers.agencyId, agencyId),
        eq(travelers.id, travelerId),
        isNull(travelers.deletedAt),
      ),
    });

    if (!traveler) return null;

    // 2. Extraer TODO el historial desde el manifiesto (bookingPassengers)
    const passengerRecords = await db
      .select({
        id: bookingPassengers.id,
        isTitular: bookingPassengers.isTitular,
        passengerStatus: bookingPassengers.status,
        bookingStatus: bookings.status,
        amountPaid: bookings.amountPaid,
        tourTitle: tours.title,
        departureDateTime: tours.departureDateTime,
      })
      .from(bookingPassengers)
      .innerJoin(bookings, eq(bookingPassengers.bookingId, bookings.id))
      .innerJoin(tours, eq(bookings.tourId, tours.id))
      .where(eq(bookingPassengers.travelerId, travelerId))
      .orderBy(desc(tours.departureDateTime));

    // 3. Procesamiento de Reglas de Negocio en memoria
    let lifetimeValue = 0;
    let activeTripsCount = 0;

    const history = passengerRecords.map((record) => {
      const isCancelled =
        record.passengerStatus === "CANCELLED" || record.bookingStatus === "CANCELLED";

      if (!isCancelled) {
        activeTripsCount++;
        // El LTV solo suma si el viajero fue quien pagó (Titular)
        if (record.isTitular) {
          lifetimeValue += Number(record.amountPaid);
        }
      }

      return {
        ...record,
        isCancelled, // Flag conveniente para el Front-End
      };
    });

    return {
      ...traveler,
      metrics: {
        totalTrips: activeTripsCount,
        lifetimeValue,
        isHabitualCompanion: lifetimeValue === 0 && activeTripsCount > 0,
      },
      history, // Mandamos la lista procesada en lugar del anidamiento de Drizzle
    };
  }
}
