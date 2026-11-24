import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  bookingPassengers,
  bookings,
  tourHotelRoomAssignments,
  tourHotelRooms,
  tourHotels,
  tours,
} from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import { findBoardingPoint } from "../../shared/utils/boarding-point.util.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  isDepositCovered,
} from "../../shared/utils/booking-rules.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";

type Executor = Pick<typeof db, "query" | "select">;

/** Datos del tour que necesita la lista de abordaje (consulta propia de cada ruta). */
export interface BoardingTour {
  id: string;
  agencyId: string;
  price: number;
  depositPerPerson: number;
  departureDateTime: string;
  returnDate: string | null;
  cancelledAt: string | null;
  boardingPoints: { id: string; time: string; location: string }[] | null;
}

/** Habitación de un pasajero en un hotel del tour (el front arma "Hab. 101" o "Matrimonial #1"). */
export interface BoardingRoom {
  hotelName: string;
  roomNumber: string | null;
  roomType: string;
  /** Orden de la habitación entre las de su tipo en ese hotel (para "Matrimonial #2"). */
  typeIndex: number;
}

/** Fila interna: cada ruta elige qué campos publica (el enlace de staff no expone ids). */
export interface BoardingRow {
  bookingPassengerId: string;
  travelerId: string;
  fullName: string;
  /** Titular actual de la reserva (el propio pasajero si es el titular). */
  holderName: string;
  isTitular: boolean;
  passengerType: string;
  seatLabel: string | null;
  boardingPointCode: string | null;
  rooms: BoardingRoom[];
  boardedAt: string | null;
  hasSeatRight: boolean;
}

/** Orden natural de etiquetas de asiento ("2" antes que "10"; "07" junto a "7"). */
export const compareSeatLabels = (a: string, b: string) =>
  a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });

/** Solo PRÓXIMO y EN CURSO admiten pasar lista (Modo Auditoría en FINALIZADO y CANCELADO). */
export const canMarkBoarding = (tour: BoardingTour, now: Date = new Date()): boolean => {
  const status = getTourTemporalStatus(
    tour.departureDateTime,
    tour.cancelledAt,
    tour.returnDate,
    now,
  );
  return status === TOUR_TEMPORAL_STATUS.UPCOMING || status === TOUR_TEMPORAL_STATUS.IN_PROGRESS;
};

/**
 * Pase de lista de abordaje (RB-MAN-002, 2026-11-23): única implementación de la lista de pasajeros
 * activos del tour y de la marca de abordaje, para el Centro de Control y el enlace de staff.
 */
export class BoardingService {
  /**
   * Pasajeros ACTIVE de reservas no canceladas ni borradas del tour (de su agencia), con titular,
   * punto de abordaje (código P1…Pn), asiento, habitaciones y abordaje. Tres consultas, sin N+1.
   */
  static async loadRows(tour: BoardingTour, executor: Executor = db) {
    const [tourBookings, rooms] = await Promise.all([
      executor.query.bookings.findMany({
        where: and(
          eq(bookings.agencyId, tour.agencyId),
          eq(bookings.tourId, tour.id),
          ne(bookings.status, "CANCELLED"),
          isNull(bookings.deletedAt),
        ),
        columns: { totalPrice: true, amountPaid: true },
        with: {
          magicToken: { columns: { numberPassengers: true } },
          traveler: { columns: { fullName: true } },
          passengers: {
            where: eq(bookingPassengers.status, "ACTIVE"),
            columns: {
              id: true,
              travelerId: true,
              isTitular: true,
              seatLabel: true,
              boardingPoint: true,
              passengerType: true,
              boardedAt: true,
            },
            with: { traveler: { columns: { fullName: true } } },
          },
        },
      }),
      executor
        .select({
          roomId: tourHotelRooms.id,
          hotelId: tourHotelRooms.hotelId,
          hotelName: tourHotels.name,
          roomNumber: tourHotelRooms.roomNumber,
          roomType: tourHotelRooms.roomType,
        })
        .from(tourHotelRooms)
        .innerJoin(tourHotels, eq(tourHotelRooms.hotelId, tourHotels.id))
        .where(and(eq(tourHotelRooms.tourId, tour.id), eq(tourHotelRooms.agencyId, tour.agencyId)))
        .orderBy(
          asc(tourHotels.createdAt),
          asc(tourHotelRooms.hotelId),
          asc(tourHotelRooms.position),
        ),
    ]);

    const passengerIds = tourBookings.flatMap((booking) => booking.passengers.map((p) => p.id));
    const assignments = passengerIds.length
      ? await executor
          .select({
            roomId: tourHotelRoomAssignments.roomId,
            bookingPassengerId: tourHotelRoomAssignments.bookingPassengerId,
          })
          .from(tourHotelRoomAssignments)
          .where(
            and(
              eq(tourHotelRoomAssignments.tourId, tour.id),
              eq(tourHotelRoomAssignments.agencyId, tour.agencyId),
              inArray(tourHotelRoomAssignments.bookingPassengerId, passengerIds),
            ),
          )
      : [];

    // "Matrimonial #2": orden de la habitación entre las de su tipo dentro de su hotel.
    const roomById = new Map<string, BoardingRoom>();
    const typeCounter = new Map<string, number>();
    for (const room of rooms) {
      const counterKey = `${room.hotelId}:${room.roomType}`;
      const typeIndex = (typeCounter.get(counterKey) ?? 0) + 1;
      typeCounter.set(counterKey, typeIndex);
      roomById.set(room.roomId, {
        hotelName: room.hotelName,
        roomNumber: room.roomNumber,
        roomType: room.roomType,
        typeIndex,
      });
    }
    const roomsByPassenger = new Map<string, BoardingRoom[]>();
    for (const assignment of assignments) {
      const room = roomById.get(assignment.roomId);
      if (!room) continue;
      const list = roomsByPassenger.get(assignment.bookingPassengerId) ?? [];
      list.push(room);
      roomsByPassenger.set(assignment.bookingPassengerId, list);
    }

    const tourBoardingPoints = tour.boardingPoints ?? [];
    const boardingPoints = tourBoardingPoints.map((point, index) => ({
      code: `P${index + 1}`,
      location: point.location,
      time: point.time,
    }));
    const toBoardingPointCode = (stored: string | null) => {
      const point = findBoardingPoint(stored, tourBoardingPoints);
      return point ? (boardingPoints[tourBoardingPoints.indexOf(point)]?.code ?? null) : null;
    };

    const rows: BoardingRow[] = tourBookings.flatMap((booking) => {
      // Derecho a asiento: misma regla que el Centro de Control (anticipo por persona × lugares).
      const groupSize = getExpectedGroupSize(
        booking.magicToken?.numberPassengers,
        Number(booking.totalPrice),
        Number(tour.price),
      );
      const hasSeatRight = isDepositCovered(
        Number(booking.amountPaid),
        getRequiredDeposit(Number(tour.depositPerPerson), groupSize),
      );
      return booking.passengers.map((passenger) => ({
        bookingPassengerId: passenger.id,
        travelerId: passenger.travelerId,
        fullName: passenger.traveler.fullName,
        holderName: booking.traveler?.fullName ?? passenger.traveler.fullName,
        isTitular: passenger.isTitular,
        passengerType: passenger.passengerType,
        seatLabel: passenger.seatLabel ?? null,
        boardingPointCode: toBoardingPointCode(passenger.boardingPoint),
        rooms: roomsByPassenger.get(passenger.id) ?? [],
        boardedAt: passenger.boardedAt ?? null,
        hasSeatRight,
      }));
    });

    // Primero por asiento (orden natural); los que no tienen asiento, al final por nombre.
    rows.sort((a, b) => {
      if (a.seatLabel && b.seatLabel) return compareSeatLabels(a.seatLabel, b.seatLabel);
      if (a.seatLabel) return -1;
      if (b.seatLabel) return 1;
      return a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" });
    });

    return { boardingPoints, rows };
  }

  /** Tour de la agencia de la sesión (404 si es ajeno o está borrado). */
  static async findAgencyTour(tourId: string, agencyId: string): Promise<BoardingTour> {
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      columns: {
        id: true,
        agencyId: true,
        price: true,
        depositPerPerson: true,
        departureDateTime: true,
        returnDate: true,
        cancelledAt: true,
        boardingPoints: true,
      },
    });
    if (!tour) throw new NotFoundError("Tour no encontrado");
    return tour;
  }

  /** Lista del Centro de Control (con sesión): identifica a cada pasajero por su `travelerId`. */
  static async getPanelList(tourId: string, agencyId: string, now: Date = new Date()) {
    const tour = await BoardingService.findAgencyTour(tourId, agencyId);
    const { boardingPoints, rows } = await BoardingService.loadRows(tour);
    return {
      canMarkBoarding: canMarkBoarding(tour, now),
      temporalStatus: getTourTemporalStatus(
        tour.departureDateTime,
        tour.cancelledAt,
        tour.returnDate,
        now,
      ),
      boardingPoints,
      passengers: rows.map((row) => ({
        travelerId: row.travelerId,
        fullName: row.fullName,
        holderName: row.holderName,
        isTitular: row.isTitular,
        passengerType: row.passengerType,
        seatLabel: row.seatLabel,
        boardingPointCode: row.boardingPointCode,
        rooms: row.rooms,
        boardedAt: row.boardedAt,
      })),
    };
  }

  /**
   * Marca o desmarca el abordaje de un pasajero del tour. El `WHERE` exige que la fila esté ACTIVE y
   * pertenezca a una reserva no cancelada ni borrada del tour y de su agencia: un id ajeno o de un
   * pasajero dado de baja no escribe nada (404). Bloquea en Modo Auditoría (409).
   */
  static async setBoarding(
    tour: BoardingTour,
    passenger: { travelerId: string } | { bookingPassengerId: string },
    boarded: boolean,
    userId: string | null,
    now: Date = new Date(),
  ) {
    assertTourNotInAuditMode(tour);
    const nowIso = now.toISOString();
    // Reservas vigentes del tour y de su agencia: la fila a marcar debe pertenecer a una de ellas.
    const tourBookingIds = sql`(select ${bookings.id} from ${bookings} where ${and(
      eq(bookings.tourId, tour.id),
      eq(bookings.agencyId, tour.agencyId),
      ne(bookings.status, "CANCELLED"),
      isNull(bookings.deletedAt),
    )})`;

    const [updated] = await db
      .update(bookingPassengers)
      .set({
        boardedAt: boarded ? nowIso : null,
        boardedByUserId: boarded ? userId : null,
        updatedAt: nowIso,
      })
      .where(
        and(
          "travelerId" in passenger
            ? eq(bookingPassengers.travelerId, passenger.travelerId)
            : eq(bookingPassengers.id, passenger.bookingPassengerId),
          eq(bookingPassengers.status, "ACTIVE"),
          sql`${bookingPassengers.bookingId} in ${tourBookingIds}`,
        ),
      )
      .returning({
        bookingPassengerId: bookingPassengers.id,
        travelerId: bookingPassengers.travelerId,
        boardedAt: bookingPassengers.boardedAt,
      });
    if (!updated) throw new NotFoundError("Pasajero no encontrado en este tour");
    return updated;
  }
}
