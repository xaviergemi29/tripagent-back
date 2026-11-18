import { eq, and, inArray, ne, isNotNull, isNull, count } from "drizzle-orm";
import { ConflictError, NotFoundError } from "../../shared/errors/domain-errors.js";
import { getLayoutSeats } from "../../shared/utils/vehicle-layout.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import { db } from "../../db/index.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  isDepositCovered,
} from "../../shared/utils/booking-rules.util.js";
import {
  bookingPassengers,
  tourBlockedSeats,
  bookings,
  travelers,
  tours,
} from "../../db/schema.js";

export class TourSeatsService {
  static async getTourSeats(tourId: string, agencyId: string) {
    // Multi-tenant: el tour debe pertenecer a la agencia de la sesión antes de leer su mapa.
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      columns: { id: true },
    });
    if (!tour) throw new NotFoundError("Tour no encontrado");

    const assignedSeats = await db
      .select({
        seatLabel: bookingPassengers.seatLabel,
        passengerId: bookingPassengers.travelerId,
        fullName: travelers.fullName,
      })
      .from(bookingPassengers)
      .innerJoin(bookings, eq(bookingPassengers.bookingId, bookings.id))
      .innerJoin(travelers, eq(bookingPassengers.travelerId, travelers.id))
      .where(
        and(
          eq(bookings.tourId, tourId),
          ne(bookings.status, "CANCELLED"),
          eq(bookingPassengers.status, "ACTIVE"),
          isNotNull(bookingPassengers.seatLabel),
        ),
      );

    const blockedSeats = await db
      .select({
        seatLabel: tourBlockedSeats.seatLabel,
        reason: tourBlockedSeats.reason,
      })
      .from(tourBlockedSeats)
      .where(eq(tourBlockedSeats.tourId, tourId));

    const payload = [
      ...assignedSeats.map((seat) => ({
        seatLabel: seat.seatLabel as string,
        status: "ASSIGNED" as const,
        passenger: {
          id: seat.passengerId, // Ahora sí mapeará con el Banquillo del Front-End
          fullName: seat.fullName,
        },
      })),
      ...blockedSeats.map((seat) => ({
        seatLabel: seat.seatLabel as string,
        status: "BLOCKED" as const,
        passenger: null,
      })),
    ];

    return payload;
  }

  static async updateSeatStatus(
    tourId: string,
    seatLabel: string,
    payload: {
      status: "AVAILABLE" | "ASSIGNED" | "BLOCKED";
      passengerId?: string | null; // Este es el traveler.id que mandas en el cURL
    },
    agencyId: string,
    userId: string,
  ) {
    return db.transaction(async (tx) => {
      // Multi-tenant: el tour debe pertenecer a la agencia de la sesión antes de tocar asientos.
      const tour = await tx.query.tours.findFirst({
        where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
        columns: {
          id: true,
          price: true,
          depositPerPerson: true,
          staffCapacity: true,
          departureDateTime: true,
          returnDate: true,
          cancelledAt: true,
        },
        with: { vehicle: { columns: { layoutMap: true } } },
      });
      if (!tour) throw new NotFoundError("Tour no encontrado");
      // Modo Auditoría (OBS-004): el croquis de un tour FINALIZADO o CANCELADO es de solo consulta
      // (asignar, mover, liberar y bloquear → 409). EN CURSO sigue operable.
      assertTourNotInAuditMode(tour);

      // Candado del tour (después de confirmar la pertenencia): los cambios de asiento de un mismo
      // tour se ejecutan uno tras otro. Sin él, dos operadores podían asignar la misma etiqueta a
      // dos pasajeros a la vez (no hay índice único por asiento) o rebasar juntos el tope de staff.
      await tx.select({ id: tours.id }).from(tours).where(eq(tours.id, tourId)).for("update");

      // Con vehículo asignado, la etiqueta debe ser un asiento del croquis. Liberar (AVAILABLE) se
      // permite siempre, para poder limpiar etiquetas de un croquis anterior.
      const layoutSeats = tour.vehicle?.layoutMap ? getLayoutSeats(tour.vehicle.layoutMap) : null;
      const layoutSeat = layoutSeats?.find((seat) => seat.label === seatLabel);
      if (layoutSeats && payload.status !== "AVAILABLE") {
        if (!layoutSeat)
          throw new NotFoundError(`Asiento ${seatLabel} no encontrado en el vehículo`);
        // El asiento de staff del croquis (p. ej. copiloto de la Sprinter) ya está reservado al
        // staff: no se vende a pasajeros ni hace falta bloquearlo.
        if (layoutSeat.kind === "STAFF") {
          throw new ConflictError(
            `El asiento ${seatLabel} está reservado para el staff en el croquis del vehículo`,
          );
        }
      }
      const layoutStaffSeats = layoutSeats?.filter((seat) => seat.kind === "STAFF").length ?? 0;

      // Regla del PM (2026-11-12): asientos de staff del croquis + bloqueos ≤ `staffCapacity`
      // (los lugares que ya se descuentan de la capacidad vendible). Así un bloqueo nunca quita un
      // asiento físico que el sistema sigue vendiendo.
      if (payload.status === "BLOCKED") {
        const [blocked] = await tx
          .select({ total: count() })
          .from(tourBlockedSeats)
          .where(
            and(eq(tourBlockedSeats.tourId, tourId), ne(tourBlockedSeats.seatLabel, seatLabel)),
          );
        const staffSeatsInUse = Number(blocked?.total ?? 0) + layoutStaffSeats;
        if (staffSeatsInUse >= tour.staffCapacity) {
          throw new ConflictError(
            tour.staffCapacity === 0
              ? "El tour no tiene lugares de staff. Aumenta «Lugares bloqueados para staff» en la configuración del tour."
              : `Ya están ocupados los ${tour.staffCapacity} lugar(es) de staff del tour (${layoutStaffSeats} del croquis + bloqueos). Libera uno o aumenta los lugares de staff.`,
          );
        }
      }

      const tourBookings = await tx
        .select({ id: bookings.id, status: bookings.status })
        .from(bookings)
        .where(eq(bookings.tourId, tourId));
      // Liberar una etiqueta aplica a todas las reservas del tour; asignar, solo a las activas
      // (antes se podía asignar asiento a un pasajero de una reserva cancelada).
      const bookingsId = tourBookings.map((b) => b.id);
      const activeBookingsId = tourBookings
        .filter((b) => b.status !== "CANCELLED")
        .map((b) => b.id);

      // Regla del PM: solo grupos que cubren el anticipo requerido tienen derecho a asiento.
      // Se valida antes de cualquier escritura para no liberar el asiento si se rechaza.
      if (payload.status === "ASSIGNED" && payload.passengerId && activeBookingsId.length > 0) {
        const passenger = await tx.query.bookingPassengers.findFirst({
          where: and(
            eq(bookingPassengers.travelerId, payload.passengerId),
            eq(bookingPassengers.status, "ACTIVE"),
            inArray(bookingPassengers.bookingId, activeBookingsId),
          ),
          columns: { id: true },
          with: {
            booking: {
              columns: { amountPaid: true, totalPrice: true },
              with: { magicToken: { columns: { numberPassengers: true } } },
            },
          },
        });
        if (!passenger) throw new NotFoundError("Pasajero no encontrado en este tour");

        const groupSize = getExpectedGroupSize(
          passenger.booking.magicToken?.numberPassengers,
          Number(passenger.booking.totalPrice),
          Number(tour.price),
        );
        const requiredDeposit = getRequiredDeposit(Number(tour.depositPerPerson), groupSize);
        if (!isDepositCovered(Number(passenger.booking.amountPaid), requiredDeposit)) {
          throw new ConflictError(
            `El grupo aún no cubre el anticipo requerido (${requiredDeposit}) para asignar asiento`,
          );
        }
      }

      if (bookingsId.length > 0) {
        await tx
          .update(bookingPassengers)
          .set({ seatLabel: null })
          .where(
            and(
              inArray(bookingPassengers.bookingId, bookingsId),
              eq(bookingPassengers.seatLabel, seatLabel),
            ),
          );
      }

      await tx
        .delete(tourBlockedSeats)
        .where(and(eq(tourBlockedSeats.tourId, tourId), eq(tourBlockedSeats.seatLabel, seatLabel)));

      if (payload.status === "ASSIGNED" && payload.passengerId) {
        // Hacemos el UPDATE buscando por el travelerId dentro de los bookings del tour actual
        const assigned =
          activeBookingsId.length > 0
            ? await tx
                .update(bookingPassengers)
                // Auditoría: quién asignó el asiento (no se borra al liberarlo).
                .set({ seatLabel, seatAssignedByUserId: userId })
                .where(
                  and(
                    eq(bookingPassengers.travelerId, payload.passengerId),
                    eq(bookingPassengers.status, "ACTIVE"),
                    inArray(bookingPassengers.bookingId, activeBookingsId),
                  ),
                )
                .returning({ id: bookingPassengers.id })
            : [];

        // Un passengerId ajeno al tour (u otra agencia) revierte la transacción en vez de
        // liberar el asiento y responder éxito sin asignar a nadie.
        if (assigned.length === 0) throw new NotFoundError("Pasajero no encontrado en este tour");
      } else if (payload.status === "BLOCKED") {
        await tx.insert(tourBlockedSeats).values({
          tourId,
          seatLabel,
          reason: "STAFF",
        });
      }

      return { success: true, seatLabel, status: payload.status };
    });
  }
}
