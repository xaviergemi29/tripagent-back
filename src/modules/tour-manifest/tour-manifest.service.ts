import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, tours, bookingPassengers } from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import { isMinorPassenger } from "../../shared/utils/mexico-date.util.js";
import { findBoardingPoint, matchesBoardingPoint } from "../../shared/utils/boarding-point.util.js";

export class TourManifestService {
  static async getTourManifest(agencyId: string, tourId: string) {
    // 1. Obtener el Tour con sus Puntos de Abordaje (JSONB)
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      columns: {
        id: true,
        title: true,
        departureDateTime: true,
        currency: true,
        boardingPoints: true,
      },
    });

    // 404 (antes un 500): el tour no existe o es de otra agencia.
    if (!tour) throw new NotFoundError("Tour no encontrado");

    // 2. Extraer Reservas Activas (Solo PAID o PARTIAL, ignorando PENDING sin pago y CANCELLED)
    const activeBookings = await db.query.bookings.findMany({
      where: and(
        eq(bookings.agencyId, agencyId),
        eq(bookings.tourId, tourId),
        ne(bookings.status, "CANCELLED"),
        ne(bookings.paymentStatus, "PENDING"), // Excluimos no pagados para el manifiesto de puerta
        isNull(bookings.deletedAt),
      ),
      columns: { id: true, totalPrice: true, amountPaid: true },
      with: {
        passengers: {
          where: eq(bookingPassengers.status, "ACTIVE"),
          columns: { isTitular: true, seatLabel: true, boardingPoint: true, passengerType: true },
          // Solo lo que imprime el manifiesto de abordaje.
          with: {
            traveler: {
              columns: {
                id: true,
                fullName: true,
                emergencyContactName: true,
                emergencyContactPhone: true,
                birthDate: true,
              },
            },
          },
        },
      },
    });

    // 3. Crear un Map para acceder rápido al cálculo de balance por booking
    const bookingBalanceMap = new Map<
      string,
      { totalPrice: number; amountPaid: number; balance: number }
    >();
    activeBookings.forEach((b) => {
      const totalPrice = Number(b.totalPrice);
      const amountPaid = Number(b.amountPaid);
      bookingBalanceMap.set(b.id, {
        totalPrice,
        amountPaid,
        balance: Math.max(0, totalPrice - amountPaid),
      });
    });

    // 4. Aplanar y estructurar todos los pasajeros activos
    const allPassengers = activeBookings.flatMap((booking) => {
      const fin = bookingBalanceMap.get(booking.id)!;

      return booking.passengers.map((p) => ({
        id: p.traveler.id,
        bookingId: booking.id,
        fullName: p.traveler.fullName,
        isTitular: p.isTitular,
        seatLabel: p.seatLabel,
        boardingPoint: p.boardingPoint,
        // 🚀 Extraemos contacto de emergencia de la tabla travelers
        emergencyContact:
          p.traveler.emergencyContactName && p.traveler.emergencyContactPhone
            ? {
                name: p.traveler.emergencyContactName,
                phone: p.traveler.emergencyContactPhone,
              }
            : null,
        balance: p.isTitular ? fin.balance : 0,
        groupSize: booking.passengers.length,
        // Aviso de menores (Art. 58, fr. X Ter, LGT); la fecha de nacimiento no se imprime.
        isMinor: isMinorPassenger({
          passengerType: p.passengerType,
          birthDate: p.traveler.birthDate,
        }),
      }));
    });

    // 5. Agrupar por Punto de Abordaje (Tolerante a ID, Ubicación o Formato Compuesto)
    const boardingPointsConfig = tour.boardingPoints || [];

    const manifestByBoardingPoint = boardingPointsConfig.map((bp) => {
      const pointPassengers = allPassengers.filter(
        (p) => !!p.boardingPoint && matchesBoardingPoint(p.boardingPoint, bp),
      );

      return {
        id: bp.id,
        location: bp.location,
        time: bp.time,
        passengers: pointPassengers,
      };
    });

    // 6. Capturar pasajeros huérfanos SOLO si realmente existen
    // Misma lógica tolerante para asegurar que no se dupliquen
    const unassignedPassengers = allPassengers.filter(
      (p) => !findBoardingPoint(p.boardingPoint, boardingPointsConfig),
    );

    // 🚀 FIX CRÍTICO: Solo agregamos la sección de "Sin asignar" si hay pasajeros reales en ella.
    // Si la lista está vacía, no generamos esta tabla fantasma en el PDF.
    if (unassignedPassengers.length > 0) {
      manifestByBoardingPoint.push({
        id: "unassigned",
        location: "Sin Punto Especificado / General",
        time: "--:--",
        passengers: unassignedPassengers,
      });
    }

    return {
      tourId: tour.id,
      tourTitle: tour.title,
      departureDateTime: tour.departureDateTime,
      currency: tour.currency,
      hasMinors: allPassengers.some((p) => p.isMinor),
      boardingPoints: manifestByBoardingPoint,
    };
  }
}
