import { ilike, or, count, desc, eq, and, isNull, isNotNull } from "drizzle-orm";

import { db } from "../../db/index.js";
import { tours } from "../../db/schema.js";
import type { CreateTourBody, GetToursQuery, UpdateTourBody } from "./tours.schema.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";

export class TourService {
  static async findTours(query: GetToursQuery, agencyId: string) {
    const { limit, offset, search } = query;

    // 1. Construimos las condiciones de búsqueda por texto (si existe)
    const searchCondition = search ? or(ilike(tours.title, `%${search}%`)) : undefined;

    // 2. Unificamos TODAS las condiciones de seguridad y filtrado en un solo 'and'
    const whereClause = and(eq(tours.agencyId, agencyId), isNull(tours.deletedAt), searchCondition);

    // 3. Ejecución de la consulta de datos paginados
    const data = await db
      .select()
      .from(tours)
      .where(whereClause)
      .orderBy(desc(tours.createdAt))
      .limit(limit)
      .offset(offset);

    // 4. Conteo total respetando el mismo aislamiento de la agencia
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(tours)
      .where(whereClause);

    const enrichedData = data.map((tour) => {
      return {
        ...tour,
        temporalStatus: getTourTemporalStatus(tour.departureDateTime, tour.isActive),
      };
    });

    return {
      data: enrichedData,
      pagination: {
        total: Number(total),
        limit,
        offset,
        hasMore: offset + data.length < Number(total),
      },
    };
  }
  /**
   * Inserta un nuevo tour en PostgreSQL de forma atómica y retorna el registro creado.
   */
  static async createTour(data: CreateTourBody, agencyId: string) {
    const [newTour] = await db
      .insert(tours)
      .values({ ...data, agencyId })
      .returning();
    return newTour;
  }

  /**
   * Obtiene un tour por su UUID.
   */
  static async findTourById(id: string, agencyId: string) {
    return await db.query.tours.findFirst({
      where: and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
    });
  }

  /**
   * Actualiza parcialmente un tour existente.
   */
  static async updateTour(id: string, data: UpdateTourBody, agencyId: string) {
    const [tourUpdated] = await db
      .update(tours)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning();
    return tourUpdated;
  }

  static async deleteTour(id: string) {
    const [tourDeleted] = await db.delete(tours).where(eq(tours.id, id)).returning();

    return tourDeleted;
  }

  static async softDeleteTour(id: string, agencyId: string) {
    // Generamos la fecha actual en formato ISO string con zona horaria
    const timestampNow = new Date().toISOString();

    const [tourDeleted] = await db
      .update(tours)
      .set({ deletedAt: timestampNow })
      .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning();

    return tourDeleted;
  }

  static async updateBrochureUrl(id: string, brochureUrl: string, agencyId: string) {
    const [updatedTour] = await db
      .update(tours)
      .set({ brochureUrl, updatedAt: new Date().toISOString() })
      .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning();

    if (!updatedTour) throw new Error("Tour no encontrado o sin permisos");
    return updatedTour;
  }

  static async assignVehicle(id: string, vehicleId: string, agencyId: string) {
    const [updatedTour] = await db
      .update(tours)
      .set({
        vehicleId,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning();

    if (!updatedTour) {
      throw new Error("Tour no encontrado o sin permisos");
    }

    return updatedTour;
  }
}
