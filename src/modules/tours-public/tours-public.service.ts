import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tours } from "../../db/schema.js";
import { BookingCapacityService } from "../bookings/booking-capacity.service.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";
import { isAgencyReadOnly } from "../../shared/utils/subscription.util.js";

/**
 * Folleto público (`/p/[id]`, sin sesión). Solo tours no borrados ni cancelados (el resto → 404) y
 * una proyección explícita (lista blanca): sin datos bancarios ni ids internos de la agencia.
 */
export class TourBrochure {
  static async findTourBrochureById(tourId: string) {
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), isNull(tours.deletedAt), isNull(tours.cancelledAt)),
      columns: {
        id: true,
        title: true,
        currency: true,
        transportModality: true,
        price: true,
        depositPerPerson: true,
        departureDateTime: true,
        returnDate: true,
        brochureUrl: true,
        boardingPoints: true,
        maxCapacity: true,
        staffCapacity: true,
        cancelledAt: true,
      },
      with: {
        // La suscripción solo decide `acceptsOnlineBookings`; no se expone.
        agency: {
          columns: {
            name: true,
            phone: true,
            logoPath: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!tour) return undefined;

    // Ocupación en vivo para el folleto (misma regla que el Centro de Control).
    const availability = await BookingCapacityService.getAvailability(db, tour);

    const isUpcoming =
      getTourTemporalStatus(tour.departureDateTime, tour.cancelledAt, tour.returnDate) ===
      TOUR_TEMPORAL_STATUS.UPCOMING;
    // Agencia en Modo Solo Lectura (2026-11-18): el folleto se sigue viendo, pero sin pre-reservas.
    const acceptsOnlineBookings = !isAgencyReadOnly(tour.agency);

    // Proyección pública explícita: las columnas internas de capacidad no se exponen tal cual.
    return {
      id: tour.id,
      title: tour.title,
      currency: tour.currency,
      transportModality: tour.transportModality,
      price: tour.price,
      depositPerPerson: tour.depositPerPerson,
      departureDateTime: tour.departureDateTime,
      returnDate: tour.returnDate,
      brochureUrl: tour.brochureUrl,
      boardingPoints: tour.boardingPoints,
      // Solo datos públicos de la agencia: nombre, teléfono y ruta del logotipo (archivo en /public).
      agency: {
        name: tour.agency.name,
        phone: tour.agency.phone,
        logoPath: tour.agency.logoPath ?? null,
      },
      availability: {
        sellableCapacity: availability.sellableCapacity,
        occupiedSeats: availability.occupiedSeats,
        availableSeats: availability.availableSeats,
        isBookable: availability.availableSeats > 0 && isUpcoming && acceptsOnlineBookings,
        // Decisión del PM (2026-11-13): un tour EN CURSO o FINALIZADO ya cerró su logística; el
        // folleto lo muestra como "Finalizado" (y no "Agotado") y la pre-reserva responde 409.
        hasDeparted: !isUpcoming,
        acceptsOnlineBookings,
      },
    };
  }
}
