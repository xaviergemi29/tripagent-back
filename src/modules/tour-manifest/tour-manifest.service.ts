import { and, eq, isNull, ne, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, tours, bookingPassengers, travelers } from "../../db/schema.js";

export class TourManifestService {
  static async getTourManifest(agencyId: string, tourId: string) {
    // 1. Obtener el Tour con sus Puntos de Abordaje (JSONB)
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
    });

    if (!tour) throw new Error("Tour no encontrado");

    // 2. Extraer Reservas Activas (Solo PAID o PARTIAL, ignorando PENDING sin pago y CANCELLED)
    const activeBookings = await db.query.bookings.findMany({
      where: and(
        eq(bookings.agencyId, agencyId),
        eq(bookings.tourId, tourId),
        ne(bookings.status, "CANCELLED"),
        ne(bookings.paymentStatus, "PENDING"), // Excluimos no pagados para el manifiesto de puerta
        isNull(bookings.deletedAt),
      ),
      with: {
        passengers: {
          where: eq(bookingPassengers.status, "ACTIVE"),
          with: { traveler: true },
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
        medicalNotes: p.traveler.medicalNotes || "",
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
      }));
    });

    // 5. Agrupar por Punto de Abordaje (Tolerante a ID, Ubicación o Formato Compuesto)
    const boardingPointsConfig = tour.boardingPoints || [];

    const manifestByBoardingPoint = boardingPointsConfig.map((bp) => {
      const pointPassengers = allPassengers.filter((p) => {
        if (!p.boardingPoint) return false;

        const normalizedStored = p.boardingPoint.trim().toLowerCase();
        const normalizedId = bp.id.trim().toLowerCase();
        const normalizedLocation = bp.location.trim().toLowerCase();

        const expectedComposite = `${bp.location} (${bp.time})`.trim().toLowerCase();

        return (
          normalizedStored === normalizedId ||
          normalizedStored === normalizedLocation ||
          normalizedStored === expectedComposite // <- ¡El match exitoso sucederá aquí!
        );
      });

      return {
        id: bp.id,
        location: bp.location,
        time: bp.time,
        passengers: pointPassengers,
      };
    });

    // 6. Capturar pasajeros huérfanos SOLO si realmente existen
    const unassignedPassengers = allPassengers.filter((p) => {
      if (!p.boardingPoint) return true;
      const normalizedStored = p.boardingPoint.trim().toLowerCase();

      // 🚀 Aplicamos la misma lógica tolerante para asegurar que no se dupliquen
      return !boardingPointsConfig.some((bp) => {
        const expectedComposite = `${bp.location} (${bp.time})`.trim().toLowerCase();
        return (
          normalizedStored === bp.id.trim().toLowerCase() ||
          normalizedStored === bp.location.trim().toLowerCase() ||
          normalizedStored === expectedComposite
        );
      });
    });

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
      boardingPoints: manifestByBoardingPoint,
    };
  }
}
