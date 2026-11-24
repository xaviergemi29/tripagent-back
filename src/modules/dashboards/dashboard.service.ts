import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, TOUR_MODALITIES, tours } from "../../db/schema.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";
import {
  getBookingFormStatus,
  getExpectedGroupSize,
  getRefundableSurplus,
  getRequiredDeposit,
  getRetainedPenaltyTotal,
  getSellableCapacity,
  isDepositCovered,
  resolveAgreedUnitPrice,
  sumOccupiedSeats,
} from "../../shared/utils/booking-rules.util.js";
import { PASSENGER_ROLE } from "../../shared/constants/domain.constants.js";
import { findBoardingPoint } from "../../shared/utils/boarding-point.util.js";
import { summarizeRefunds } from "../../shared/utils/refund.util.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import { describeStaffShare } from "../../shared/utils/staff-share.util.js";

export class DashboardService {
  static async getTourDashboard(agencyId: string, tourId: string) {
    // 1. Obtener la cabecera del tour
    const tour = await db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)),
      with: {
        vehicle: true,
        // Solo el nombre: antes se cargaba la agencia completa (datos bancarios) sin usarla.
        agency: { columns: { name: true } },
      },
    });

    // 404 (antes un 500): el tour no existe o es de otra agencia.
    if (!tour) throw new NotFoundError("Tour no encontrado");

    const toBoardingPointDetails = (stored: string | null) => {
      const point = findBoardingPoint(stored, tour.boardingPoints ?? []);
      return point ? { location: point.location, time: point.time } : null;
    };

    // 2. Reservas del tour: las activas y, aparte, las que canceló el CLIENTE (filtro "Canceladas"
    // del Centro de Control, 2026-11-17: solo consulta y anulación de abonos mal capturados).
    const tourBookings = await db.query.bookings.findMany({
      where: and(
        eq(bookings.agencyId, agencyId),
        eq(bookings.tourId, tourId),
        isNull(bookings.deletedAt),
      ),
      with: {
        // Solo lo que muestra el Centro de Control (sin notas médicas ni contactos de emergencia).
        passengers: {
          with: {
            traveler: {
              columns: {
                id: true,
                fullName: true,
                whatsappPhone: true,
              },
            },
          },
        },
        magicToken: { columns: { token: true, numberPassengers: true } },
        payments: {
          orderBy: (payments, { desc }) => [desc(payments.createdAt)],
          // Solo el nombre de quien registró el abono: antes se cargaba la fila completa del
          // usuario, incluido su hash de contraseña.
          with: { createdByUser: { columns: { fullName: true } } },
        },
      },
    });

    const activeBookings = tourBookings.filter((booking) => booking.status !== "CANCELLED");
    // Si la agencia canceló el tour, sus reservas canceladas van en `refunds` (reembolsos).
    const clientCancelledBookings = tour.cancelledAt
      ? []
      : tourBookings.filter((booking) => booking.status === "CANCELLED");

    // 2.1 Reservas canceladas (para los reembolsos): solo si la AGENCIA canceló el tour (decisión del
    // PM, 2026-11-14). Cuando el cliente cancela, la agencia retiene lo abonado como penalización y no
    // hay devolución en efectivo. No cuentan para la ocupación ni para los KPI.
    const cancelledBookings = !tour.cancelledAt
      ? []
      : await db.query.bookings.findMany({
          where: and(
            eq(bookings.agencyId, agencyId),
            eq(bookings.tourId, tourId),
            eq(bookings.status, "CANCELLED"),
            isNull(bookings.deletedAt),
          ),
          with: {
            traveler: { columns: { id: true, fullName: true, whatsappPhone: true } },
            magicToken: { columns: { numberPassengers: true } },
            payments: {
              orderBy: (payments, { desc }) => [desc(payments.createdAt)],
              with: { createdByUser: { columns: { fullName: true } } },
            },
          },
        });

    const isTourUSD = tour.currency === "USD";
    type BookingPayment = (typeof activeBookings)[number]["payments"][number];
    const toPaymentRecord = (payment: BookingPayment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      method: payment.method as "CASH" | "TRANSFER" | "CARD" | "OTHER",
      type: payment.type as "PAYMENT" | "REFUND",
      createdAt: payment.createdAt,
      referenceInfo: payment.referenceInfo || null,
      registeredBy: payment?.createdByUser?.fullName || null,
      amountUSD: isTourUSD ? Number(payment.amount) : null,
      amountMXN: payment.collectedCurrency === "MXN" ? Number(payment.collectedAmount) : null,
      exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
    });

    // 3. Inicialización de Métricas de Negocio
    // Ocupación (regla 12): todas las reservas no canceladas, sin importar pago ni formulario.
    const soldSeats = sumOccupiedSeats(
      activeBookings.map((booking) => ({
        totalPrice: Number(booking.totalPrice),
        numberPassengers: booking.magicToken?.numberPassengers,
      })),
      Number(tour.price),
    );
    const sellableCapacity = getSellableCapacity(tour.maxCapacity, tour.staffCapacity);
    let collectedRevenue = 0;
    // Sin flujo de validación de pagos en el MVP: siempre 0 (el front lo espera en `metrics`).
    const pendingValidationsCount = 0;

    // Logística: Solo contamos a los que tienen derecho a asiento (han pagado)
    let eligibleForSeatCount = 0;
    let assignedSeatsCount = 0;

    const groupedTravelers = [];
    const cancelledTravelers = [];
    const baseTourPrice = Number(tour.price) || 1; // Fallback para evitar Div/0

    // 4. Transformación y Agregación (Single Pass - O(N))
    for (const booking of [...activeBookings, ...clientCancelledBookings]) {
      // Una reserva cancelada por el cliente se muestra con el mismo formato, pero no cuenta para
      // ingresos, asientos ni derecho a asiento (todos sus pasajeros ya están cancelados).
      const isCancelled = booking.status === "CANCELLED";
      const amountPaid = Number(booking.amountPaid || 0);
      const totalPrice = Number(booking.totalPrice || 0);
      if (!isCancelled) collectedRevenue += amountPaid;

      // Prioridad 1: Token Criptográfico (Fuente de verdad si se auto-registraron)
      // Prioridad 2: Heurística Financiera (Total Pagado / Precio Unitario)
      const expectedGroupSize = getExpectedGroupSize(
        booking.magicToken?.numberPassengers,
        totalPrice,
        baseTourPrice,
      );

      const passengersList = booking.passengers || [];
      const activePassengers = isCancelled
        ? passengersList
        : passengersList.filter((p) => p.status !== "CANCELLED");
      const titularRow = activePassengers.find((p) => p.isTitular);
      if (!titularRow) continue;

      // Regla del PM: derecho a asiento cuando lo pagado cubre el anticipo requerido
      // (anticipo por persona × lugares apartados). Antes bastaba cualquier abono.
      const requiredDeposit = getRequiredDeposit(Number(tour.depositPerPerson), expectedGroupSize);
      const hasSeatRight = !isCancelled && isDepositCovered(amountPaid, requiredDeposit);

      if (hasSeatRight) {
        eligibleForSeatCount += expectedGroupSize;
      }

      // Contar cuántos de ESTA reserva ya tienen asiento asignado
      if (!isCancelled) {
        activePassengers.forEach((p) => {
          if (p.seatLabel) {
            assignedSeatsCount++;
          }
        });
      }

      // Del estado de la reserva, no del viajero (CRM compartido entre reservas).
      const formStatus = getBookingFormStatus(booking);
      // Precio pactado por lugar (`bookings.unitPrice`; respaldo total ÷ lugares), el mismo que usan
      // las altas y bajas de lugares.
      const unitPrice = resolveAgreedUnitPrice({
        unitPrice: booking.unitPrice,
        totalPrice,
        numberPassengers: booking.magicToken?.numberPassengers,
        tourPrice: baseTourPrice,
      });

      // 4.1 Mapeo de Acompañantes
      const mappedCompanions = activePassengers
        .filter((p) => !p.isTitular)
        .map((comp) => ({
          id: comp.traveler.id,
          bookingId: booking.id,
          role: PASSENGER_ROLE.COMPANION,
          fullName: comp.traveler.fullName,
          whatsapp: comp.traveler.whatsappPhone || "Sin teléfono",
          formStatus,
          seatLabel: comp.seatLabel || null,
          boardingPoint: comp.boardingPoint || null,
          // Punto configurado del tour (ubicación y hora); misma regla que el manifiesto.
          boardingPointDetails: toBoardingPointDetails(comp.boardingPoint),
        }));

      // 4.2 Mapeo de Pagos
      let totalEquivalentMXN = 0;

      const mappedPayments = (booking.payments || []).map((payment) => {
        const record = toPaymentRecord(payment);
        const amountMXN = record.amountMXN;

        // `collectedAmount` ya se guarda con signo (negativo en REFUND y anulaciones), así que se
        // suma tal cual. Antes se restaba un monto negativo y el reembolso AUMENTABA el equivalente.
        if (amountMXN) totalEquivalentMXN += amountMXN;

        return record;
      });

      const balance = Math.max(0, totalPrice - amountPaid);
      // Bajas de acompañantes (FLUJO-RES-004, 2026-11-17): retenciones acumuladas en el total y saldo
      // a devolver al titular. Solo en reservas activas (una cancelada tiene su propia retención).
      const retainedPenaltyTotal = isCancelled
        ? 0
        : getRetainedPenaltyTotal({ totalPrice, unitPrice, groupSize: expectedGroupSize });
      const refundableSurplus = isCancelled ? 0 : getRefundableSurplus({ amountPaid, totalPrice });

      // 4.3 Mapeo del Titular
      const titularGroupRow = {
        id: titularRow.traveler.id,
        bookingId: booking.id,
        role: PASSENGER_ROLE.TITULAR,
        fullName: titularRow.traveler.fullName,
        whatsapp: titularRow.traveler.whatsappPhone || "Sin teléfono",
        // 🚀 Inyectamos el tamaño real del grupo esperado al Front-End
        groupSize: expectedGroupSize,
        unitPrice,
        bookingStatus: booking.status,
        requiredDeposit,
        hasSeatRight,
        // Fecha del apartado: el Centro de Control muestra cuánto lleva sin pago (revisión manual
        // de las 48 h, regla 13; el sistema no cancela nada).
        bookedAt: booking.createdAt,

        formStatus,
        seatLabel: titularRow.seatLabel || null,
        boardingPoint: titularRow.boardingPoint || null,
        boardingPointDetails: toBoardingPointDetails(titularRow.boardingPoint),
        magicToken: booking.magicToken?.token || null,

        paymentStatus: booking.paymentStatus, // PENDING | PARTIAL | PAID | REFUNDED (enum de BD)
        paidAmount: amountPaid,
        balance,
        retainedPenaltyTotal,
        refundableSurplus,
        equivalentMXN: totalEquivalentMXN > 0 ? totalEquivalentMXN : null,

        payments: mappedPayments,
        companions: mappedCompanions,
      };
      if (isCancelled) cancelledTravelers.push(titularGroupRow);
      else groupedTravelers.push(titularGroupRow);
    }

    // 4.4 Reembolsos (decisión del PM, 2026-11-14): reservas canceladas con dinero abonado. El saldo
    // a reembolsar es lo pagado neto menos la penalización retenida (summarizeRefunds, única regla).
    const refunds = cancelledBookings
      .map((booking) => ({
        booking,
        summary: summarizeRefunds({
          amountPaid: booking.amountPaid,
          totalPrice: booking.totalPrice,
          payments: booking.payments,
        }),
      }))
      .filter(({ summary }) => summary.paidAmount > 0)
      .map(({ booking, summary }) => ({
        bookingId: booking.id,
        travelerId: booking.traveler.id,
        fullName: booking.traveler.fullName,
        whatsapp: booking.traveler.whatsappPhone || "Sin teléfono",
        groupSize: getExpectedGroupSize(
          booking.magicToken?.numberPassengers,
          Number(booking.totalPrice),
          baseTourPrice,
        ),
        ...summary,
        payments: booking.payments.map(toPaymentRecord),
      }));

    // 5. Retorno limpio respetando el schema Zod del Frontend
    return {
      id: tour.id,
      title: tour.title,
      agencyName: tour.agency.name,
      requiresSeats: tour.transportModality === TOUR_MODALITIES.enumValues[0] ? true : false,
      currency: tour.currency as "MXN" | "USD",
      departureDateTime: tour.departureDateTime,
      returnDate: tour.returnDate ?? null,
      // Indicaciones de logística del tour para el estado de cuenta PDF del operador.
      postPaymentInstructions: tour.postPaymentInstructions?.trim() || null,
      // PRÓXIMO | EN CURSO | FINALIZADO | CANCELADO (TOUR_TEMPORAL_STATUS), igual que el listado.
      temporalStatus: getTourTemporalStatus(
        tour.departureDateTime,
        tour.cancelledAt,
        tour.returnDate,
      ),
      // Cancelación por la agencia (o null). La nota es interna: solo la ve el operador.
      cancellation: tour.cancelledAt
        ? {
            cancelledAt: tour.cancelledAt,
            reason: tour.cancellationReason,
            note: tour.cancellationNote ?? null,
          }
        : null,

      metrics: {
        occupancy: {
          max: sellableCapacity,
          current: soldSeats,
        },
        revenue: {
          projected: sellableCapacity * Number(tour.price),
          collected: collectedRevenue,
        },
        logistics: {
          total: eligibleForSeatCount,
          assigned: assignedSeatsCount,
          unassigned: eligibleForSeatCount - assignedSeatsCount,
        },
        pendingValidations: pendingValidationsCount,
      },

      // Lugares de staff: tope de asientos que el operador puede bloquear en el croquis.
      staffCapacity: tour.staffCapacity,

      vehicle: tour.vehicle
        ? {
            id: tour.vehicle.id,
            templateId: tour.vehicle.templateId,
            name: tour.vehicle.name,
            layoutMap: tour.vehicle.layoutMap,
            // Operador excluido; `staff` = asientos reservados al staff por el croquis.
            capacity: getVehicleCapacity(tour.vehicle.layoutMap),
          }
        : null,

      // Enlace de staff (regla 26): `{ token, expiresAt, isExpired }` o `null` sin enlace activo.
      staffShare: describeStaffShare(tour),

      travelers: groupedTravelers,
      // Canceladas por el cliente (mismo formato que `travelers`, `bookingStatus: CANCELLED`); vacío
      // si la agencia canceló el tour (esas van en `refunds`).
      cancelledTravelers,
      refunds,
    };
  }
}
