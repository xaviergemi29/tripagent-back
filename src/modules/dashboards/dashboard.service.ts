import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, TOUR_MODALITIES, tours } from "../../db/schema.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  isDepositCovered,
} from "../../shared/utils/booking-rules.util.js";

export class DashboardService {
  static async getTourDashboard(agencyId: string, tourId: string) {
    // 1. Obtener la cabecera del tour
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      with: {
        vehicle: true,
        agency: true,
      },
    });

    if (!tour) throw new Error("Tour no encontrado");

    // 2. Extraer reservas activas
    const activeBookings = await db.query.bookings.findMany({
      where: and(
        eq(bookings.agencyId, agencyId),
        eq(bookings.tourId, tourId),
        ne(bookings.status, "CANCELLED"),
        isNull(bookings.deletedAt),
      ),
      with: {
        traveler: true,
        passengers: {
          with: { traveler: true },
        },
        magicToken: true,
        payments: {
          orderBy: (payments, { desc }) => [desc(payments.createdAt)],
          with: { createdByUser: true },
        },
      },
    });

    // 3. Inicialización de Métricas de Negocio
    let soldSeats = 0; // Ocupación Real (Pagados/Apartados)
    let collectedRevenue = 0;
    let pendingValidationsCount = 0;

    // Logística: Solo contamos a los que tienen derecho a asiento (han pagado)
    let eligibleForSeatCount = 0;
    let assignedSeatsCount = 0;

    const groupedTravelers = [];
    const baseTourPrice = Number(tour.price) || 1; // Fallback para evitar Div/0

    // 4. Transformación y Agregación (Single Pass - O(N))
    for (const booking of activeBookings) {
      const amountPaid = Number(booking.amountPaid || 0);
      const totalPrice = Number(booking.totalPrice || 0);
      collectedRevenue += amountPaid;

      // Prioridad 1: Token Criptográfico (Fuente de verdad si se auto-registraron)
      // Prioridad 2: Heurística Financiera (Total Pagado / Precio Unitario)
      const expectedGroupSize = getExpectedGroupSize(
        booking.magicToken?.numberPassengers,
        totalPrice,
        baseTourPrice,
      );

      soldSeats += expectedGroupSize;

      const passengersList = booking.passengers || [];
      const activePassengers = passengersList.filter((p) => p.status !== "CANCELLED");
      const titularRow = activePassengers.find((p) => p.isTitular);
      if (!titularRow) continue;

      // Regla del PM: derecho a asiento cuando lo pagado cubre el anticipo requerido
      // (anticipo por persona × lugares apartados). Antes bastaba cualquier abono.
      const requiredDeposit = getRequiredDeposit(Number(tour.depositPerPerson), expectedGroupSize);
      const hasSeatRight = isDepositCovered(amountPaid, requiredDeposit);

      if (hasSeatRight) {
        eligibleForSeatCount += expectedGroupSize;
      }

      // Contar cuántos de ESTA reserva ya tienen asiento asignado
      activePassengers.forEach((p) => {
        if (p.seatLabel) {
          assignedSeatsCount++;
        }
      });

      const isTitularFormPending = !titularRow.traveler.emergencyContactPhone;
      const unitPrice = totalPrice / expectedGroupSize;

      // 4.1 Mapeo de Acompañantes
      const mappedCompanions = activePassengers
        .filter((p) => !p.isTitular)
        .map((comp) => ({
          id: comp.traveler.id,
          bookingId: booking.id,
          role: "COMPANION" as const,
          fullName: comp.traveler.fullName,
          whatsapp: comp.traveler.whatsappPhone || "Sin teléfono",
          formStatus: !comp.traveler.emergencyContactPhone ? "PENDING" : "COMPLETED",
          seatLabel: comp.seatLabel || null,
          boardingPoint: comp.boardingPoint || null,
        }));

      // 4.2 Mapeo de Pagos
      let totalEquivalentMXN = 0;
      const isTourUSD = tour.currency === "USD";

      const mappedPayments = (booking.payments || []).map((payment) => {
        const isCrossCurrency = payment.collectedCurrency === "MXN";
        const amountMXN = isCrossCurrency ? Number(payment.collectedAmount) : null;

        if (amountMXN && payment.type === "PAYMENT") {
          totalEquivalentMXN += amountMXN;
        } else if (amountMXN && payment.type === "REFUND") {
          totalEquivalentMXN -= amountMXN;
        }

        return {
          id: payment.id,
          amount: Number(payment.amount),
          method: payment.method as "CASH" | "TRANSFER" | "CARD" | "OTHER",
          type: payment.type as "PAYMENT" | "REFUND",
          createdAt: payment.createdAt,
          referenceInfo: payment.referenceInfo || null,
          registeredBy: payment?.createdByUser?.fullName || null,
          amountUSD: isTourUSD ? Number(payment.amount) : null,
          amountMXN: amountMXN,
          exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
        };
      });

      const balance = Math.max(0, totalPrice - amountPaid);

      // 4.3 Mapeo del Titular
      groupedTravelers.push({
        id: titularRow.traveler.id,
        bookingId: booking.id,
        role: "TITULAR" as const,
        fullName: titularRow.traveler.fullName,
        whatsapp: titularRow.traveler.whatsappPhone || "Sin teléfono",
        // 🚀 Inyectamos el tamaño real del grupo esperado al Front-End
        groupSize: expectedGroupSize,
        unitPrice,
        bookingStatus: booking.status,
        requiredDeposit,
        hasSeatRight,

        formStatus: isTitularFormPending ? "PENDING" : "COMPLETED",
        seatLabel: titularRow.seatLabel || null,
        boardingPoint: titularRow.boardingPoint || null,
        magicToken: booking.magicToken?.token || null,

        paymentStatus: booking.paymentStatus as
          "PENDING" | "ADVANCE" | "PAID" | "PENDING_VALIDATION",
        paidAmount: amountPaid,
        balance,
        equivalentMXN: totalEquivalentMXN > 0 ? totalEquivalentMXN : null,

        payments: mappedPayments,
        companions: mappedCompanions,
      });
    }

    // 5. Retorno limpio respetando el schema Zod del Frontend
    return {
      id: tour.id,
      title: tour.title,
      agencyName: tour.agency.name,
      requiresSeats: tour.transportModality === TOUR_MODALITIES.enumValues[0] ? true : false,
      currency: tour.currency as "MXN" | "USD",
      departureDateTime: tour.departureDateTime,
      temporalStatus: getTourTemporalStatus(tour.departureDateTime, tour.isActive) as
        "ACTIVO" | "FINALIZADO" | "CANCELADO",

      metrics: {
        occupancy: {
          max: tour.maxCapacity,
          current: soldSeats,
        },
        revenue: {
          projected: tour.maxCapacity * Number(tour.price),
          collected: collectedRevenue,
        },
        logistics: {
          total: eligibleForSeatCount,
          assigned: assignedSeatsCount,
          unassigned: eligibleForSeatCount - assignedSeatsCount,
        },
        pendingValidations: pendingValidationsCount,
      },

      vehicle: tour.vehicle
        ? {
            id: tour.vehicle.id,
            name: tour.vehicle.name,
            layoutMap: tour.vehicle.layoutMap as (string | null)[][],
          }
        : null,

      travelers: groupedTravelers,
    };
  }
}
