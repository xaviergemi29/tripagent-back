import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingPassengers, bookings, tourBlockedSeats, tours } from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { findBoardingPoint } from "../../shared/utils/boarding-point.util.js";
import { getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  isDepositCovered,
} from "../../shared/utils/booking-rules.util.js";
import {
  STAFF_SHARE_UNAVAILABLE_MESSAGE,
  generateStaffShareToken,
  getStaffShareExpiresAt,
  isStaffShareExpired,
  staffShareTokenSchema,
} from "../../shared/utils/staff-share.util.js";

export const SEAT_RIGHT_STATUS = {
  CONFIRMED: "CONFIRMED",
  PENDING_DEPOSIT: "PENDING_DEPOSIT",
} as const;

/** Orden natural de etiquetas de asiento ("2" antes que "10"; "07" junto a "7"). */
const compareSeatLabels = (a: string, b: string) =>
  a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });

/** Cualquier enlace no válido responde igual (404, mismo mensaje): no es un oráculo. */
const unavailable = () => new NotFoundError(STAFF_SHARE_UNAVAILABLE_MESSAGE);

/**
 * Enlace de staff (regla 26 de `../CLAUDE.md`, 2026-11-22): croquis y lista de pasajeros de solo
 * lectura para el coordinador del viaje, sin cuenta. Reemplaza la hoja de cálculo compartida.
 */
export class StaffShareService {
  /**
   * Crea o regenera el token del tour (el anterior deja de funcionar). 404 si el tour no es de la
   * agencia; 409 en Modo Auditoría (FINALIZADO o CANCELADO).
   */
  static async createOrRegenerate(tourId: string, agencyId: string, userId: string) {
    return db.transaction(async (tx) => {
      const [tour] = await tx
        .select({
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
        })
        .from(tours)
        .where(and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
        .for("update");
      if (!tour) throw new NotFoundError("Tour no encontrado");
      assertTourNotInAuditMode(tour);

      const token = generateStaffShareToken();
      const now = new Date().toISOString();
      await tx
        .update(tours)
        .set({
          staffShareToken: token,
          staffShareTokenCreatedByUserId: userId,
          updatedByUserId: userId,
          updatedAt: now,
        })
        .where(and(eq(tours.id, tourId), eq(tours.agencyId, agencyId)));

      return {
        token,
        expiresAt: getStaffShareExpiresAt(tour.departureDateTime, tour.returnDate).toISOString(),
      };
    });
  }

  /**
   * Desactiva el enlace (token = null). Se permite también en Modo Auditoría: revocar el acceso a
   * datos personales nunca debe quedar bloqueado. 404 si el tour no es de la agencia.
   */
  static async disable(tourId: string, agencyId: string, userId: string) {
    const [updated] = await db
      .update(tours)
      .set({ staffShareToken: null, updatedByUserId: userId, updatedAt: new Date().toISOString() })
      .where(and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning({ id: tours.id });
    if (!updated) throw new NotFoundError("Tour no encontrado");
    return { token: null };
  }

  /**
   * Vista pública del enlace. 404 con el mismo mensaje si el token tiene un formato inválido (sin
   * consultar la base), no existe, venció, el tour está cancelado o borrado, o la agencia está
   * suspendida o borrada. Proyección estricta: sin montos, teléfonos, correos, contactos de
   * emergencia, fechas de nacimiento, ids internos ni magic tokens (LFPDPPP, regla 25).
   */
  static async getPublicView(rawToken: string, now: Date = new Date()) {
    const parsedToken = staffShareTokenSchema.safeParse(rawToken);
    if (!parsedToken.success) throw unavailable();

    const tour = await db.query.tours.findFirst({
      where: and(
        eq(tours.staffShareToken, parsedToken.data),
        isNull(tours.deletedAt),
        isNull(tours.cancelledAt),
      ),
      columns: {
        id: true,
        agencyId: true,
        title: true,
        price: true,
        depositPerPerson: true,
        departureDateTime: true,
        returnDate: true,
        cancelledAt: true,
        boardingPoints: true,
      },
      with: {
        agency: { columns: { name: true, logoPath: true, isActive: true, deletedAt: true } },
        vehicle: { columns: { name: true, layoutMap: true } },
      },
    });
    if (!tour) throw unavailable();
    // Agencia suspendida (bloqueo total por impago, regla 20) o borrada: no expone nada. El Modo
    // Solo Lectura, en cambio, no afecta: el enlace es una consulta.
    if (!tour.agency.isActive || tour.agency.deletedAt) throw unavailable();

    const expiresAt = getStaffShareExpiresAt(tour.departureDateTime, tour.returnDate);
    if (isStaffShareExpired(expiresAt, now)) throw unavailable();

    const [blockedRows, tourBookings] = await Promise.all([
      db
        .select({ seatLabel: tourBlockedSeats.seatLabel })
        .from(tourBlockedSeats)
        .where(eq(tourBlockedSeats.tourId, tour.id)),
      db.query.bookings.findMany({
        where: and(
          eq(bookings.agencyId, tour.agencyId),
          eq(bookings.tourId, tour.id),
          ne(bookings.status, "CANCELLED"),
          isNull(bookings.deletedAt),
        ),
        columns: { totalPrice: true, amountPaid: true },
        with: {
          magicToken: { columns: { numberPassengers: true } },
          passengers: {
            where: eq(bookingPassengers.status, "ACTIVE"),
            columns: { isTitular: true, seatLabel: true, boardingPoint: true, passengerType: true },
            with: { traveler: { columns: { fullName: true } } },
          },
        },
      }),
    ]);

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

    const passengers = tourBookings.flatMap((booking) => {
      // Derecho a asiento: misma regla que el Centro de Control (anticipo por persona × lugares
      // apartados). Solo se publica el estado, nunca los montos.
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
        seatLabel: passenger.seatLabel ?? null,
        fullName: passenger.traveler.fullName,
        passengerType: passenger.passengerType,
        isTitular: passenger.isTitular,
        boardingPointCode: toBoardingPointCode(passenger.boardingPoint),
        seatRightStatus: hasSeatRight
          ? SEAT_RIGHT_STATUS.CONFIRMED
          : SEAT_RIGHT_STATUS.PENDING_DEPOSIT,
      }));
    });

    // Primero por asiento (orden natural); los que no tienen asiento, al final por nombre.
    passengers.sort((a, b) => {
      if (a.seatLabel && b.seatLabel) return compareSeatLabels(a.seatLabel, b.seatLabel);
      if (a.seatLabel) return -1;
      if (b.seatLabel) return 1;
      return a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" });
    });

    return {
      tour: {
        title: tour.title,
        departureDate: tour.departureDateTime,
        returnDate: tour.returnDate ?? null,
        temporalStatus: getTourTemporalStatus(
          tour.departureDateTime,
          tour.cancelledAt,
          tour.returnDate,
          now,
        ),
      },
      agency: { name: tour.agency.name, logoPath: tour.agency.logoPath ?? null },
      expiresAt: expiresAt.toISOString(),
      vehicle: tour.vehicle
        ? {
            name: tour.vehicle.name,
            layoutMap: tour.vehicle.layoutMap,
            capacity: getVehicleCapacity(tour.vehicle.layoutMap),
          }
        : null,
      blockedSeats: blockedRows.map((row) => row.seatLabel).sort(compareSeatLabels),
      boardingPoints,
      passengers,
    };
  }
}
