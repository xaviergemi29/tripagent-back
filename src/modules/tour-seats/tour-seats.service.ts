import { eq, and, inArray, ne, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingPassengers, tourBlockedSeats, bookings, travelers } from "../../db/schema.js";

export class TourSeatsService {
  static async getTourSeats(tourId: string) {
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
  ) {
    return db.transaction(async (tx) => {
      const tourBookings = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.tourId, tourId));
      const bookingsId = tourBookings.map((b) => b.id);

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

      if (payload.status === "ASSIGNED" && payload.passengerId && bookingsId.length > 0) {
        // Hacemos el UPDATE buscando por el travelerId dentro de los bookings del tour actual
        await tx
          .update(bookingPassengers)
          .set({ seatLabel })
          .where(
            and(
              eq(bookingPassengers.travelerId, payload.passengerId),
              inArray(bookingPassengers.bookingId, bookingsId),
            ),
          );
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
