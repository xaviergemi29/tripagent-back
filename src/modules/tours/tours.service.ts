import {
  ilike,
  count,
  desc,
  eq,
  and,
  isNull,
  isNotNull,
  inArray,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import { db, type DbExecutor } from "../../db/index.js";
import {
  bookingPassengers,
  bookings,
  payments,
  tourBlockedSeats,
  tours,
  vehicles,
} from "../../db/schema.js";
import type {
  CancelTourBody,
  CreateTourBody,
  GetToursQuery,
  UpdateTourBody,
} from "./tours.schema.js";
import { BookingService } from "../bookings/booking.service.js";
import { TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import { getSellableCapacity, sumOccupiedSeats } from "../../shared/utils/booking-rules.util.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { getLayoutSeatLabels, getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";
import { VehicleTemplatesService } from "../vehicle-templates/vehicle-templates.service.js";
import { BookingCapacityService } from "../bookings/booking-capacity.service.js";
import { BookingStatusService } from "../bookings/booking-status.service.js";
import { FROZEN_PRICING_ERROR, STAFF_CAPACITY_ERROR } from "./tours.schema.js";
import { removeUpload } from "../../shared/storage/uploads.js";
import { isPastDate, PAST_DEPARTURE_ERROR } from "../../shared/utils/mexico-date.util.js";

/** Prefijo de los archivos de folleto de un tour: un tour solo puede borrar SUS folletos. */
export const brochureFilePrefix = (tourId: string) => `tour-${tourId}-`;

export class TourService {
  static async findTours(query: GetToursQuery, agencyId: string) {
    const { limit, offset, search } = query;

    const searchQueryCondition = search ? ilike(tours.title, `%${search}%`) : undefined;

    const whereClause = and(
      eq(tours.agencyId, agencyId),
      isNull(tours.deletedAt),
      searchQueryCondition,
    );

    const fetchedTours = await db
      .select()
      .from(tours)
      .where(whereClause)
      // `id` como desempate: con altas en el mismo instante, el orden por `offset` sería
      // inestable y el front (que pide todas las páginas) podría repetir u omitir registros.
      .orderBy(desc(tours.createdAt), desc(tours.id))
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
        // Solo lo que usa el cálculo de ocupación (antes traía la reserva y el token completos).
        columns: { tourId: true, totalPrice: true },
        with: { magicToken: { columns: { numberPassengers: true } } },
      });

      // Misma regla de ocupación que el Centro de Control y la validación de cupo (regla 12).
      for (const tour of fetchedTours) {
        occupancyMap.set(
          tour.id,
          sumOccupiedSeats(
            activeBookings
              .filter((booking) => booking.tourId === tour.id)
              .map((booking) => ({
                totalPrice: Number(booking.totalPrice),
                numberPassengers: booking.magicToken?.numberPassengers,
              })),
            Number(tour.price),
          ),
        );
      }
    }

    const enrichedTours = fetchedTours.map((tour) => {
      return {
        ...tour,
        temporalStatus: getTourTemporalStatus(
          tour.departureDateTime,
          tour.cancelledAt,
          tour.returnDate,
        ),
        currentOccupancy: occupancyMap.get(tour.id) || 0,
        sellableCapacity: getSellableCapacity(tour.maxCapacity, tour.staffCapacity),
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
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
    });
    if (!tour) return undefined;

    // `hasPayments`: la UI de edición congela moneda y precio (la API también lo valida).
    // `temporalStatus`: la UI no ofrece la edición de un tour FINALIZADO o CANCELADO (Modo
    // Auditoría, OBS-004; la API responde 409 al guardarlo).
    return {
      ...tour,
      hasPayments: await TourService.hasRegisteredPayments(db, id),
      temporalStatus: getTourTemporalStatus(
        tour.departureDateTime,
        tour.cancelledAt,
        tour.returnDate,
      ),
    };
  }

  /** ¿Existe al menos un movimiento en `payments` (abono, reembolso o anulación) del tour? */
  static async hasRegisteredPayments(executor: DbExecutor, tourId: string): Promise<boolean> {
    const [row] = await executor
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(bookings, eq(payments.bookingId, bookings.id))
      .where(eq(bookings.tourId, tourId))
      .limit(1);
    return !!row;
  }

  /**
   * Actualiza parcialmente un tour existente, en una transacción con la fila del tour bloqueada.
   * - Capacidad: si el PATCH trae solo uno de los dos campos, se valida contra el valor guardado.
   * - Moneda y precio congelados (decisión del PM): con pagos registrados → ConflictError (409).
   * - Si cambia el anticipo, se recalcula el estado de cada reserva activa (regla 11).
   */
  static async updateTour(id: string, data: UpdateTourBody, agencyId: string) {
    const { removeBrochure, ...restData } = data;

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          maxCapacity: tours.maxCapacity,
          staffCapacity: tours.staffCapacity,
          price: tours.price,
          currency: tours.currency,
          depositPerPerson: tours.depositPerPerson,
          brochureUrl: tours.brochureUrl,
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
        })
        .from(tours)
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!current) return undefined;

      // Modo Auditoría (OBS-004; decisión del usuario, 2026-11-17): un tour FINALIZADO o CANCELADO
      // no se edita. El listado oculta "Editar Tour" en esos estados.
      assertTourNotInAuditMode(current);

      // La salida no se mueve al pasado (2026-11-17): un tour con reservas pasaría a FINALIZADO.
      // Conservar la fecha guardada (aunque ya haya pasado) sí se permite.
      if (
        restData.departureDateTime !== undefined &&
        restData.departureDateTime !== current.departureDateTime &&
        isPastDate(restData.departureDateTime)
      ) {
        throw new BusinessRuleError(PAST_DEPARTURE_ERROR);
      }

      if (restData.maxCapacity !== undefined || restData.staffCapacity !== undefined) {
        const maxCapacity = restData.maxCapacity ?? current.maxCapacity;
        const staffCapacity = restData.staffCapacity ?? current.staffCapacity;
        const sellableCapacity = getSellableCapacity(maxCapacity, staffCapacity);
        if (sellableCapacity < 1) {
          throw new BusinessRuleError(STAFF_CAPACITY_ERROR);
        }
        // Decisión del PM (2026-11-14): la capacidad vendible nunca queda por debajo de los
        // lugares ya ocupados (regla 12); evita sobreventas lógicas. La fila del tour ya está
        // bloqueada (FOR UPDATE), así que ninguna reserva nueva se cuela entre la lectura y el cambio.
        const occupiedSeats = await BookingCapacityService.getOccupiedSeats(
          tx,
          id,
          Number(current.price),
        );
        if (sellableCapacity < occupiedSeats) {
          throw new ConflictError(
            `No puedes dejar ${sellableCapacity} lugares a la venta: el tour ya tiene ${occupiedSeats} lugares ocupados. Ajusta la capacidad total o los lugares de staff.`,
          );
        }
      }

      const changesCurrency =
        restData.currency !== undefined && restData.currency !== current.currency;
      const changesPrice =
        restData.price !== undefined && Number(restData.price) !== Number(current.price);
      if ((changesCurrency || changesPrice) && (await TourService.hasRegisteredPayments(tx, id))) {
        throw new ConflictError(FROZEN_PRICING_ERROR);
      }

      const [tourUpdated] = await tx
        .update(tours)
        .set({
          ...restData,
          ...(removeBrochure ? { brochureUrl: null } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .returning();

      const changesDeposit =
        restData.depositPerPerson !== undefined &&
        Number(restData.depositPerPerson) !== Number(current.depositPerPerson);
      if (changesDeposit) {
        const activeBookings = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.tourId, id),
              ne(bookings.status, "CANCELLED"),
              isNull(bookings.deletedAt),
            ),
          );
        for (const booking of activeBookings) {
          await BookingStatusService.syncStatus(tx, booking.id);
        }
      }

      return { tourUpdated, previousBrochureUrl: current.brochureUrl };
    });

    if (!result) return undefined;

    // El archivo físico se borra solo después de confirmar la transacción, y solo si es un folleto
    // de ESTE tour (prefijo `tour-<id>-`).
    if (removeBrochure && result.previousBrochureUrl) {
      await removeUpload("brochures", result.previousBrochureUrl, brochureFilePrefix(id));
    }

    return result.tourUpdated;
  }

  /**
   * Cancelación del tour por la agencia (decisión del PM, 2026-11-14): evento definitivo de fuerza
   * mayor (clima, seguridad, cupo mínimo, otra causa). En una transacción con la fila del tour
   * bloqueada:
   * - guarda `cancelledAt`, el motivo y la nota (el tour pasa a CANCELADO: Modo Auditoría y fuera del
   *   folleto);
   * - cancela todas las reservas no canceladas con penalización $0 (`applyFullCancellation`: libera
   *   asientos y deja todo lo abonado como saldo a reembolsar).
   * Rechaza (409) un tour ya cancelado o FINALIZADO. Un tour EN CURSO sí se puede cancelar (p. ej.
   * cierre carretero el día de salida).
   */
  static async cancelTour(id: string, body: CancelTourBody, agencyId: string) {
    return db.transaction(async (tx) => {
      const [tour] = await tx
        .select({
          id: tours.id,
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
          currency: tours.currency,
        })
        .from(tours)
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!tour) return undefined;

      if (tour.cancelledAt) {
        throw new ConflictError("El tour ya fue cancelado.");
      }
      if (
        getTourTemporalStatus(tour.departureDateTime, tour.cancelledAt, tour.returnDate) ===
        TOUR_TEMPORAL_STATUS.FINISHED
      ) {
        throw new ConflictError("No se puede cancelar un tour que ya finalizó.");
      }

      const now = new Date().toISOString();
      await tx
        .update(tours)
        .set({
          cancelledAt: now,
          cancellationReason: body.reason,
          cancellationNote: body.note ?? null,
          updatedAt: now,
        })
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId)));

      const activeBookings = await tx
        .select({
          id: bookings.id,
          totalPrice: bookings.totalPrice,
          amountPaid: bookings.amountPaid,
          paymentStatus: bookings.paymentStatus,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.tourId, id),
            ne(bookings.status, "CANCELLED"),
            isNull(bookings.deletedAt),
          ),
        );

      let refundableTotal = 0;
      for (const booking of activeBookings) {
        // La agencia cancela: no hay penalización, se devuelve todo lo abonado.
        const summary = await BookingService.applyFullCancellation(tx, booking, 0);
        refundableTotal += summary.surplusAmount;
      }

      return {
        tourId: id,
        cancelledAt: now,
        reason: body.reason,
        cancelledBookings: activeBookings.length,
        refundableTotal: Math.round(refundableTotal * 100) / 100,
        currency: tour.currency,
      };
    });
  }

  /**
   * Borrado lógico (decisión del PM): se rechaza (ConflictError → 409) si el tour tiene reservas
   * no canceladas o dinero abonado (SUM(amountPaid) ≠ 0 en sus reservas no borradas). Primero
   * hay que cancelar y reembolsar. La fila del tour se bloquea para que no entre una reserva
   * mientras se valida.
   */
  static async softDeleteTour(id: string, agencyId: string) {
    return db.transaction(async (tx) => {
      const [tour] = await tx
        .select({ id: tours.id, currency: tours.currency })
        .from(tours)
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!tour) return undefined;

      const [summary] = await tx
        .select({
          activeBookings: sql<number>`count(*) filter (where ${bookings.status} <> 'CANCELLED')`,
          totalPaid: sql<string>`coalesce(sum(${bookings.amountPaid}), 0)`,
        })
        .from(bookings)
        .where(and(eq(bookings.tourId, id), isNull(bookings.deletedAt)));

      const activeBookings = Number(summary?.activeBookings ?? 0);
      const totalPaid = Number(summary?.totalPaid ?? 0);

      if (activeBookings > 0) {
        throw new ConflictError(
          `No se puede eliminar el tour: tiene ${activeBookings} reserva(s) activa(s). Cancélalas primero desde el Centro de Control.`,
        );
      }
      if (totalPaid !== 0) {
        throw new ConflictError(
          `No se puede eliminar el tour: sus reservas conservan $${totalPaid.toLocaleString("es-MX")} ${tour.currency} abonados. Reembolsa los abonos antes de eliminarlo.`,
        );
      }

      const [tourDeleted] = await tx
        .update(tours)
        .set({ deletedAt: new Date().toISOString() })
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .returning();

      return tourDeleted;
    });
  }

  /** ¿El tour existe, no está borrado y es de la agencia? (antes de escribir archivos en disco). */
  static async existsForAgency(id: string, agencyId: string): Promise<boolean> {
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      columns: { id: true },
    });
    return !!tour;
  }

  /**
   * Guarda la ruta del folleto nuevo y devuelve el tour + la ruta anterior, para que la ruta HTTP
   * borre el archivo viejo solo después de confirmar la base (mismo patrón que el logotipo).
   */
  static async updateBrochureUrl(id: string, brochureUrl: string, agencyId: string) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          brochureUrl: tours.brochureUrl,
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
        })
        .from(tours)
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!current) throw new NotFoundError("Tour no encontrado");
      // Modo Auditoría (OBS-004): el folleto de un tour FINALIZADO o CANCELADO no cambia. La ruta
      // borra el archivo recién escrito al recibir el error.
      assertTourNotInAuditMode(current);

      const [updatedTour] = await tx
        .update(tours)
        .set({ brochureUrl, updatedAt: new Date().toISOString() })
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId)))
        .returning();
      if (!updatedTour) throw new NotFoundError("Tour no encontrado");

      return { tour: updatedTour, previousBrochureUrl: current.brochureUrl ?? null };
    });
  }

  /**
   * Asigna o cambia el vehículo del tour (decisión del PM, 2026-11-12):
   * 0. Con `templateId`, se reutiliza o crea la unidad de la agencia para esa plantilla del
   *    catálogo (copia del croquis). Con `vehicleId`, la unidad ya existe.
   * 1. El vehículo y el tour deben ser de la agencia (404).
   * 2. Candado físico: los asientos de PASAJERO del croquis (sin operador ni asientos de staff)
   *    deben alcanzar para los lugares que ya tienen derecho a asiento (anticipo cubierto).
   *    Si no, ConflictError (409) sin escribir nada.
   * 3. Se liberan SIEMPRE los asientos de pasajeros y los bloqueos de staff cuya etiqueta no existe
   *    en el nuevo layout. Los que sí existen se conservan con la misma etiqueta.
   * `maxCapacity` no se modifica: sigue siendo la capacidad planeada que captura el operador.
   */
  static async assignVehicle(
    id: string,
    target: { vehicleId?: string | undefined; templateId?: string | undefined },
    agencyId: string,
  ) {
    return db.transaction(async (tx) => {
      const vehicle = target.templateId
        ? await VehicleTemplatesService.findOrCreateAgencyVehicle(tx, target.templateId, agencyId)
        : await tx.query.vehicles.findFirst({
            where: and(eq(vehicles.id, target.vehicleId ?? ""), eq(vehicles.agencyId, agencyId)),
            columns: { id: true, layoutMap: true },
          });
      if (!vehicle) {
        throw new NotFoundError("Vehículo no encontrado o sin permisos");
      }
      const vehicleId = vehicle.id;

      // Bloquea la fila del tour: ninguna reserva cambia de cupo mientras se valida.
      const [tour] = await tx
        .select({
          id: tours.id,
          price: tours.price,
          depositPerPerson: tours.depositPerPerson,
          vehicleId: tours.vehicleId,
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
        })
        .from(tours)
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!tour) {
        throw new NotFoundError("Tour no encontrado o sin permisos");
      }

      // Modo Auditoría (OBS-004): un tour FINALIZADO o CANCELADO no asigna ni cambia unidad.
      assertTourNotInAuditMode(tour);
      // EN CURSO (petición del usuario, 2026-11-17): el tour ya salió en su vehículo, así que no se
      // cambia. Asignar la primera unidad (sin vehículo) o la misma sigue permitido.
      if (
        getTourTemporalStatus(tour.departureDateTime, tour.cancelledAt, tour.returnDate) ===
          TOUR_TEMPORAL_STATUS.IN_PROGRESS &&
        tour.vehicleId &&
        tour.vehicleId !== vehicleId
      ) {
        throw new ConflictError("El tour ya está en curso: no se puede cambiar de vehículo.");
      }

      const seatLabels = getLayoutSeatLabels(vehicle.layoutMap ?? []);
      const passengerSeats = getVehicleCapacity(vehicle.layoutMap ?? []).passenger;
      const seatRightSeats = await BookingCapacityService.getSeatRightSeats(tx, tour);
      if (passengerSeats < seatRightSeats) {
        throw new ConflictError(
          `El vehículo tiene ${passengerSeats} asientos de pasajero y ${seatRightSeats} pasajeros ya tienen derecho a asiento. Elige una unidad con más capacidad.`,
        );
      }

      const [updatedTour] = await tx
        .update(tours)
        .set({ vehicleId, updatedAt: new Date().toISOString() })
        .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .returning();
      if (!updatedTour) {
        throw new NotFoundError("Tour no encontrado o sin permisos");
      }

      // Asientos de pasajeros con etiqueta que no existe en el nuevo layout (incluye etiquetas no
      // numéricas o con otro formato, que antes quedaban ocultas).
      const tourBookingIds = tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.tourId, id));
      const releasedPassengers = await tx
        .update(bookingPassengers)
        .set({ seatLabel: null, updatedAt: new Date().toISOString() })
        .where(
          and(
            inArray(bookingPassengers.bookingId, tourBookingIds),
            isNotNull(bookingPassengers.seatLabel),
            seatLabels.length > 0 ? notInArray(bookingPassengers.seatLabel, seatLabels) : undefined,
          ),
        )
        .returning({ seatLabel: bookingPassengers.seatLabel, status: bookingPassengers.status });

      const releasedBlocks = await tx
        .delete(tourBlockedSeats)
        .where(
          and(
            eq(tourBlockedSeats.tourId, id),
            seatLabels.length > 0 ? notInArray(tourBlockedSeats.seatLabel, seatLabels) : undefined,
          ),
        )
        .returning({ seatLabel: tourBlockedSeats.seatLabel });

      return {
        ...updatedTour,
        // Solo cuentan los pasajeros activos (los cancelados también se limpian, pero no se ven).
        releasedSeats: {
          passengers: releasedPassengers.filter((p) => p.status === "ACTIVE").length,
          blocked: releasedBlocks.length,
        },
      };
    });
  }
}
