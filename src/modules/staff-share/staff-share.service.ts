import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tourBlockedSeats, tours } from "../../db/schema.js";
import { ConflictError, NotFoundError } from "../../shared/errors/domain-errors.js";
import { isAgencyReadOnly } from "../../shared/utils/subscription.util.js";
import {
  BoardingService,
  canMarkBoarding,
  compareSeatLabels,
  type BoardingRow,
} from "../boarding/boarding.service.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { getVehicleCapacity } from "../../shared/utils/vehicle-layout.util.js";
import {
  STAFF_SHARE_UNAVAILABLE_MESSAGE,
  boardingKeySchema,
  buildBoardingKey,
  generateStaffShareToken,
  getStaffShareExpiresAt,
  isStaffShareExpired,
  staffShareTokenSchema,
} from "../../shared/utils/staff-share.util.js";

export const SEAT_RIGHT_STATUS = {
  CONFIRMED: "CONFIRMED",
  PENDING_DEPOSIT: "PENDING_DEPOSIT",
} as const;

/** Pase de lista desde el enlace con la agencia en Modo Solo Lectura (la consulta sigue abierta). */
export const STAFF_SHARE_READ_ONLY_MESSAGE =
  "La agencia está en modo solo lectura: puedes consultar la lista, pero no marcar el abordaje.";

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
  /**
   * Tour del enlace (validación completa del token): 404 con el mismo mensaje si el token tiene un
   * formato inválido (sin consultar la base), no existe, venció, el tour está cancelado o borrado, o
   * la agencia está suspendida o borrada. El Modo Solo Lectura no lo apaga (es una consulta).
   */
  static async resolvePublicTour(rawToken: string, now: Date = new Date()) {
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
        agency: {
          columns: {
            name: true,
            logoPath: true,
            isActive: true,
            deletedAt: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            createdAt: true,
            subscriptionPeriodEndsAt: true,
          },
        },
        vehicle: { columns: { name: true, layoutMap: true } },
      },
    });
    if (!tour) throw unavailable();
    // Agencia suspendida (bloqueo total por impago, regla 20) o borrada: no expone nada.
    if (!tour.agency.isActive || tour.agency.deletedAt) throw unavailable();

    const expiresAt = getStaffShareExpiresAt(tour.departureDateTime, tour.returnDate);
    if (isStaffShareExpired(expiresAt, now)) throw unavailable();
    return { tour, token: parsedToken.data, expiresAt };
  }

  /**
   * Pase de lista desde el enlace (RB-MAN-002): permitido en un tour PRÓXIMO o EN CURSO y con la
   * agencia fuera del Modo Solo Lectura. Lo decide la API; el front solo lo muestra.
   */
  private static canMarkFromLink(
    tour: Awaited<ReturnType<typeof StaffShareService.resolvePublicTour>>["tour"],
    now: Date,
  ) {
    return canMarkBoarding(tour, now) && !isAgencyReadOnly(tour.agency, now);
  }

  /**
   * Pasajeros del enlace: sin ids internos; cada uno lleva una `boardingKey` opaca derivada del token
   * para marcar su abordaje. Sin montos, teléfonos, correos ni contactos (LFPDPPP, regla 25).
   */
  private static toPublicPassengers(rows: BoardingRow[], token: string) {
    return rows.map((row) => ({
      boardingKey: buildBoardingKey(token, row.bookingPassengerId),
      seatLabel: row.seatLabel,
      fullName: row.fullName,
      holderName: row.holderName,
      passengerType: row.passengerType,
      isTitular: row.isTitular,
      boardingPointCode: row.boardingPointCode,
      seatRightStatus: row.hasSeatRight
        ? SEAT_RIGHT_STATUS.CONFIRMED
        : SEAT_RIGHT_STATUS.PENDING_DEPOSIT,
      rooms: row.rooms.map(({ hotelName, roomNumber, roomType, typeIndex }) => ({
        hotelName,
        roomNumber,
        roomType,
        typeIndex,
      })),
      boardedAt: row.boardedAt,
    }));
  }

  /**
   * Vista pública del enlace: croquis, lista y pase de lista. Proyección estricta: sin montos,
   * teléfonos, correos, contactos de emergencia, fechas de nacimiento, ids internos ni magic tokens.
   */
  static async getPublicView(rawToken: string, now: Date = new Date()) {
    const { tour, token, expiresAt } = await StaffShareService.resolvePublicTour(rawToken, now);

    const [blockedRows, { boardingPoints, rows }] = await Promise.all([
      db
        .select({ seatLabel: tourBlockedSeats.seatLabel })
        .from(tourBlockedSeats)
        .where(eq(tourBlockedSeats.tourId, tour.id)),
      BoardingService.loadRows(tour),
    ]);

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
      canMarkBoarding: StaffShareService.canMarkFromLink(tour, now),
      passengers: StaffShareService.toPublicPassengers(rows, token),
    };
  }

  /** Solo el pase de lista (la página lo vuelve a pedir cada 15 s): más ligero que la vista. */
  static async getPublicBoarding(rawToken: string, now: Date = new Date()) {
    const { tour, token } = await StaffShareService.resolvePublicTour(rawToken, now);
    const { boardingPoints, rows } = await BoardingService.loadRows(tour);
    return {
      canMarkBoarding: StaffShareService.canMarkFromLink(tour, now),
      temporalStatus: getTourTemporalStatus(
        tour.departureDateTime,
        tour.cancelledAt,
        tour.returnDate,
        now,
      ),
      boardingPoints,
      passengers: StaffShareService.toPublicPassengers(rows, token),
    };
  }

  /**
   * Marca o desmarca el abordaje desde el enlace (sin sesión: `boardedByUserId = null`). La clave
   * se resuelve contra los pasajeros activos de ESE tour: una clave de otro enlace o de un pasajero
   * dado de baja responde 404 sin escribir. Modo Auditoría → 409; Solo Lectura → 409.
   */
  static async setPublicBoarding(
    rawToken: string,
    rawKey: string,
    boarded: boolean,
    now: Date = new Date(),
  ) {
    const { tour, token } = await StaffShareService.resolvePublicTour(rawToken, now);
    assertTourNotInAuditMode(tour);
    if (isAgencyReadOnly(tour.agency, now)) {
      throw new ConflictError(STAFF_SHARE_READ_ONLY_MESSAGE);
    }
    const key = boardingKeySchema.safeParse(rawKey);
    if (!key.success) throw new NotFoundError("Pasajero no encontrado en este tour");

    const { rows } = await BoardingService.loadRows(tour);
    const row = rows.find(
      (candidate) => buildBoardingKey(token, candidate.bookingPassengerId) === key.data,
    );
    if (!row) throw new NotFoundError("Pasajero no encontrado en este tour");

    const updated = await BoardingService.setBoarding(
      tour,
      { bookingPassengerId: row.bookingPassengerId },
      boarded,
      null,
      now,
    );
    return { boardingKey: key.data, boardedAt: updated.boardedAt ?? null };
  }
}
