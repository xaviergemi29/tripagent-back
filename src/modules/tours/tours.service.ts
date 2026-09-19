import { ilike, or, count, desc, eq, and, isNull, isNotNull } from "drizzle-orm";

import { db } from "../../db/index.js";
import { tours } from "../../db/schema.js";
import type { CreateTourBody, GetToursQuery, UpdateTourBody } from "./tours.schema.js";

export class TourService {
  // 🚀 NUEVO: Helpers puro y aislado para lógica temporal
  static getTourTemporalStatus(departureDate: string, isActive: boolean): string {
    // Regla 1: Cancelación manual absoluta
    if (!isActive) return "CANCELADO";

    // Extraemos la fecha actual exacta en México (YYYY-MM-DD)
    const todayMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

    // Validamos que departureDate exista antes de operar
    if (!departureDate) return "PRÓXIMO";

    // Matemática de fechas segura tipada explícitamente
    const tourDate = new Date(`${departureDate}T12:00:00Z`);
    tourDate.setDate(tourDate.getDate() + 1); // +24 horas (1 día de tolerancia)

    // Aseguramos que el resultado no sea undefined usando un fallback o conversión segura
    const toleranceDate: string = tourDate.toISOString().split("T")[0] ?? departureDate;

    // Regla 2: Evaluaciones temporales
    if (todayMX < departureDate) return "PRÓXIMO";
    if (todayMX >= departureDate && todayMX <= toleranceDate) return "EN CURSO";
    return "FINALIZADO";
  }

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
        temporalStatus: this.getTourTemporalStatus(tour.departureDateTime, tour.isActive),
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
}
