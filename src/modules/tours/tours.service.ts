import { ilike, or, count, desc, eq, and, isNull, isNotNull, inArray, ne } from "drizzle-orm";

import { db } from "../../db/index.js";
import { bookingPassengers, bookings, tours, vehicles } from "../../db/schema.js";
import type { CreateTourBody, GetToursQuery, UpdateTourBody } from "./tours.schema.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { unlink } from "node:fs/promises";
import path from "node:path";

export class TourService {
  static async findTours(query: GetToursQuery, agencyId: string) {
    const { limit, offset, search } = query;

    const searchQueryCondition = search ? or(ilike(tours.title, `%${search}%`)) : undefined;

    const whereClause = and(
      eq(tours.agencyId, agencyId),
      isNull(tours.deletedAt),
      searchQueryCondition,
    );

    const fetchedTours = await db
      .select()
      .from(tours)
      .where(whereClause)
      .orderBy(desc(tours.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ totalRecords } = { totalRecords: 0 }] = await db
      .select({ totalRecords: count() })
      .from(tours)
      .where(whereClause);

    const tourIds = fetchedTours.map((tour) => tour.id);
    const occupancyMap = new Map<string, number>();

    if (tourIds.length > 0) {
      const activeBookings = await db.query.bookings.findMany({
        where: and(
          inArray(bookings.tourId, tourIds),
          ne(bookings.status, "CANCELLED"), // Ignoramos estrictamente las canceladas
          isNull(bookings.deletedAt),
        ),
        with: {
          magicToken: true,
        },
      });

      for (const booking of activeBookings) {
        const matchingTour = fetchedTours.find((t) => t.id === booking.tourId);
        const baseTourPrice = Number(matchingTour?.price) || 1;
        const totalPrice = Number(booking.totalPrice) || 0;

        // Misma heurística del Centro de Control
        const expectedGroupSize = booking.magicToken?.numberPassengers
          ? booking.magicToken.numberPassengers
          : Math.max(1, Math.round(totalPrice / baseTourPrice));

        const currentOccupancy = occupancyMap.get(booking.tourId) || 0;
        occupancyMap.set(booking.tourId, currentOccupancy + expectedGroupSize);
      }
    }

    const enrichedTours = fetchedTours.map((tour) => {
      return {
        ...tour,
        temporalStatus: getTourTemporalStatus(tour.departureDateTime, tour.isActive),
        currentOccupancy: occupancyMap.get(tour.id) || 0,
      };
    });

    return {
      data: enrichedTours,
      pagination: {
        total: Number(totalRecords),
        limit,
        offset,
        hasMore: offset + fetchedTours.length < Number(totalRecords),
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
    const { removeBrochure, ...restData } = data;

    // Esto garantiza que TypeScript chille si intentas hacer update de una columna que no existe
    const updatePayload = {
      ...restData,
      updatedAt: new Date().toISOString(),
    };

    if (removeBrochure) {
      updatePayload.brochureUrl = null;

      const currentTour = await db.query.tours.findFirst({
        where: and(eq(tours.id, id), eq(tours.agencyId, agencyId)),
        columns: { brochureUrl: true },
      });

      if (currentTour?.brochureUrl) {
        const fileName = currentTour.brochureUrl.split("/").pop();
        if (fileName) {
          const absolutePath = path.join(process.cwd(), "public", "uploads", "brochures", fileName);
          await unlink(absolutePath).catch((err) =>
            console.warn(`[FS] No se pudo borrar el folleto físico: ${err.message}`),
          );
        }
      }
    }

    const [tourUpdated] = await db
      .update(tours)
      .set(updatePayload)
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

  static async assignVehicle(
    id: string,
    vehicleId: string,
    agencyId: string,
    resetOrphans: boolean = false,
  ) {
    return await db.transaction(async (tx) => {
      // 1. Asignamos el vehículo al tour (bloqueando el registro)
      const [updatedTour] = await tx
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

      // 2. Lógica condicional destructiva (Reset Orphans)
      if (resetOrphans) {
        // a. Obtener la capacidad del nuevo vehículo
        const vehicle = await tx.query.vehicles.findFirst({
          where: eq(vehicles.id, vehicleId),
          columns: { layoutMap: true },
        });

        if (vehicle?.layoutMap) {
          const layout = vehicle.layoutMap as (string | null)[][];
          // Capacidad = total de celdas que no son nulas ni pasillos
          const newCapacity = layout.flat().filter((cell) => cell && cell !== "AISLE").length;

          // b. Obtener todos los pasajeros actuales del tour con un asiento asignado
          // Utilizamos un inner join implícito de Drizzle relacional
          const activeBookings = await tx.query.bookings.findMany({
            where: and(eq(bookings.tourId, id), eq(bookings.agencyId, agencyId)),
            with: {
              passengers: {
                where: isNotNull(bookingPassengers.seatLabel),
                columns: { id: true, seatLabel: true },
              },
            },
          });

          // c. Evaluar en memoria cuáles asientos superan la nueva capacidad
          const orphanPassengerIds: string[] = [];

          for (const b of activeBookings) {
            for (const p of b.passengers) {
              const seatNum = Number(p.seatLabel);
              // Si el asiento es un número válido y es mayor a la capacidad, es huérfano
              if (!isNaN(seatNum) && seatNum > newCapacity) {
                orphanPassengerIds.push(p.id);
              }
            }
          }

          // d. Liberar (Nullify) los asientos huérfanos de un solo golpe
          if (orphanPassengerIds.length > 0) {
            await tx
              .update(bookingPassengers)
              .set({
                seatLabel: null,
                updatedAt: new Date().toISOString(),
              })
              .where(inArray(bookingPassengers.id, orphanPassengerIds));
          }
        }
      }

      return updatedTour;
    });
  }
}
