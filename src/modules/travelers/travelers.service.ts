import {
  ilike,
  or,
  count,
  desc,
  eq,
  and,
  inArray,
  isNull,
  ne,
  sql,
  getTableColumns,
} from "drizzle-orm";
import { phoneLookupCandidates } from "../../shared/utils/phone.util.js";
import { ConflictError } from "../../shared/errors/domain-errors.js";
import { db } from "../../db/index.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";
import { bookingPassengers, bookings, tours, travelers } from "../../db/schema.js";
import type { GetTravelersQuery, UpdateTravelerBody } from "./travelers.schema.js";

/** Mensaje del 409 por WhatsApp repetido (el mismo que el del índice único en las rutas). */
const DUPLICATE_PHONE_MESSAGE = "Ya existe un viajero registrado con ese WhatsApp";

/**
 * Mientras convivan el E.164 y los 10 dígitos anteriores, el índice único (agencia, WhatsApp) no
 * detecta que `+522281234567` y `2281234567` son el mismo número: se revisa aquí (→ 409).
 */
async function assertPhoneAvailable(e164: string, agencyId: string, exceptId?: string) {
  const duplicate = await db.query.travelers.findFirst({
    where: and(
      eq(travelers.agencyId, agencyId),
      inArray(travelers.whatsappPhone, phoneLookupCandidates(e164)),
      isNull(travelers.deletedAt),
      exceptId ? ne(travelers.id, exceptId) : undefined,
    ),
    columns: { id: true },
  });
  if (duplicate) throw new ConflictError(DUPLICATE_PHONE_MESSAGE);
}

/** Nombre que queda en las reservas y pagos de un viajero eliminado (anonimizado). */
export const ANONYMIZED_TRAVELER_NAME = "Pasajero Eliminado";

export class TravelerService {
  /**
   * Autocompletar público del Magic Link (`lookup-traveler`): solo los campos que la ruta devuelve.
   * Nunca carga notas médicas. `undefined` si no existe. (Antes no esperaba la promesa, así que su
   * `if (!traveler) throw …` nunca se cumplía.)
   */
  static async findSingleTravelerByPhone(phone: string, agencyId: string) {
    return db.query.travelers.findFirst({
      where: and(
        // `phone` ya viene en E.164; también se buscan los 10 dígitos de registros anteriores.
        inArray(travelers.whatsappPhone, phoneLookupCandidates(phone)),
        eq(travelers.agencyId, agencyId),
        isNull(travelers.deletedAt),
      ),
      columns: {
        fullName: true,
        email: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        birthDate: true,
      },
    });
  }

  static async findTravelers(query: GetTravelersQuery, agencyId: string) {
    const { search, limit, offset } = query;

    const searchCondition = search
      ? or(
          ilike(travelers.fullName, `%${search}%`),
          ilike(travelers.email, `%${search}%`),
          ilike(travelers.whatsappPhone, `%${search}%`),
        )
      : undefined;

    const whereClause = and(
      eq(travelers.agencyId, agencyId),
      isNull(travelers.deletedAt),
      searchCondition,
    );

    const data = await db
      .select({
        ...getTableColumns(travelers),

        // Mantenemos tu contador actual
        tripCount: sql<number>`(
          SELECT count(*)::int
          FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
        )`.mapWith(Number),

        // NUEVO: Subquery para obtener el nombre del próximo tour
        nextTourName: sql<string | null>`(
          SELECT t.title
          FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          JOIN ${tours} t ON t.id = b.tour_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
            AND t.departure_date_time >= CURRENT_DATE
          ORDER BY t.departure_date_time ASC
          LIMIT 1
        )`,

        // NUEVO: Subquery para obtener la fecha del próximo tour
        nextTourDate: sql<string | null>`(
          SELECT t.departure_date_time
          FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          JOIN ${tours} t ON t.id = b.tour_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
            AND t.departure_date_time >= CURRENT_DATE
          ORDER BY t.departure_date_time ASC
          LIMIT 1
        )`,

        hasNationalTrips: sql<boolean>`EXISTS(
          SELECT 1 FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          JOIN ${tours} t ON t.id = b.tour_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
            AND t.destination_type = 'NATIONAL'
        )`,

        hasInternationalTrips: sql<boolean>`EXISTS(
          SELECT 1 FROM ${bookingPassengers} bp
          JOIN ${bookings} b ON b.id = bp.booking_id
          JOIN ${tours} t ON t.id = b.tour_id
          WHERE bp.traveler_id = "travelers"."id"
            AND bp.status = 'ACTIVE'
            AND b.booking_status != 'CANCELLED'
            AND t.destination_type = 'INTERNATIONAL'
        )`,
      })
      .from(travelers)
      .where(whereClause)
      // `id` como desempate: con altas en el mismo instante, el orden por `offset` sería
      // inestable y el front (que pide todas las páginas) podría repetir u omitir registros.
      .orderBy(desc(travelers.createdAt), desc(travelers.id))
      .limit(limit)
      .offset(offset);

    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(travelers)
      .where(whereClause);

    return {
      data,
      pagination: {
        total: Number(total),
        limit,
        offset,
        hasMore: offset + data.length < Number(total),
      },
    };
  }

  /**
   * Actualiza parcialmente un viajero y retorna la entidad modificada.
   * Ejecuta una sola consulta atómica usando la cláusula RETURNING de PostgreSQL.
   */
  static async updateTraveler(id: string, params: UpdateTravelerBody, agencyId: string) {
    if (params.whatsappPhone) await assertPhoneAvailable(params.whatsappPhone, agencyId, id);
    const [updatedTraveler] = await db
      .update(travelers)
      .set({
        ...params,
        // Un número nuevo sin país (cliente anterior) queda sin confirmar: nunca conserva el país
        // del número que reemplaza.
        ...(params.whatsappPhone !== undefined && {
          whatsappCountry: params.whatsappCountry ?? null,
        }),
        ...(params.emergencyContactPhone !== undefined && {
          emergencyContactCountry: params.emergencyContactCountry ?? null,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(travelers.id, id), eq(travelers.agencyId, agencyId), isNull(travelers.deletedAt)),
      )
      .returning();
    return updatedTraveler;
  }

  /**
   * Eliminar viajero = borrado lógico + anonimización (derecho de cancelación ARCO, LFPDPPP;
   * decisión del PM, 2026-11-22). Se borran sus datos personales y se conserva la fila con sus
   * reservas, pagos y asientos, para que la caja y el historial de la agencia sigan cuadrando.
   * Irreversible. Con un viaje próximo o en curso responde 409: primero se cancela o transfiere su
   * lugar (si no, el manifiesto de ese tour quedaría con un "Pasajero Eliminado").
   * Devuelve `null` si no existe o es de otra agencia (la ruta responde 404).
   */
  static async softDeleteTraveler(id: string, agencyId: string) {
    return db.transaction(async (tx) => {
      const traveler = await tx.query.travelers.findFirst({
        where: and(
          eq(travelers.id, id),
          eq(travelers.agencyId, agencyId),
          isNull(travelers.deletedAt),
        ),
        columns: { id: true },
      });
      if (!traveler) return null;

      const activeTrips = await tx
        .select({
          departureDateTime: tours.departureDateTime,
          returnDate: tours.returnDate,
          cancelledAt: tours.cancelledAt,
        })
        .from(bookingPassengers)
        .innerJoin(bookings, eq(bookingPassengers.bookingId, bookings.id))
        .innerJoin(tours, eq(bookings.tourId, tours.id))
        .where(
          and(
            eq(bookingPassengers.travelerId, id),
            eq(bookingPassengers.status, "ACTIVE"),
            ne(bookings.status, "CANCELLED"),
            isNull(bookings.deletedAt),
            isNull(tours.deletedAt),
          ),
        );
      const hasUpcomingTrip = activeTrips.some((trip) => {
        const status = getTourTemporalStatus(
          trip.departureDateTime,
          trip.cancelledAt,
          trip.returnDate,
        );
        return (
          status === TOUR_TEMPORAL_STATUS.UPCOMING || status === TOUR_TEMPORAL_STATUS.IN_PROGRESS
        );
      });
      if (hasUpcomingTrip) {
        throw new ConflictError(
          "Este viajero tiene un viaje próximo o en curso. Cancela o transfiere su lugar antes de eliminarlo.",
        );
      }

      const now = new Date().toISOString();
      const [deleted] = await tx
        .update(travelers)
        .set({
          fullName: ANONYMIZED_TRAVELER_NAME,
          whatsappPhone: null,
          whatsappCountry: null,
          email: null,
          emergencyContactName: "",
          emergencyContactPhone: "",
          emergencyContactCountry: null,
          birthDate: null,
          customFields: {},
          deletedAt: now,
          updatedAt: now,
        })
        .where(and(eq(travelers.id, id), eq(travelers.agencyId, agencyId)))
        .returning({ id: travelers.id, deletedAt: travelers.deletedAt });

      return deleted ?? null;
    });
  }

  static async getTravelerHistory(travelerId: string, agencyId: string) {
    // 1. Validar existencia del viajero
    const traveler = await db.query.travelers.findFirst({
      where: and(
        eq(travelers.agencyId, agencyId),
        eq(travelers.id, travelerId),
        isNull(travelers.deletedAt),
      ),
    });

    if (!traveler) return null;

    // 2. Extraer TODO el historial desde el manifiesto (bookingPassengers)
    const passengerRecords = await db
      .select({
        id: bookingPassengers.id,
        isTitular: bookingPassengers.isTitular,
        passengerStatus: bookingPassengers.status,
        bookingStatus: bookings.status,
        amountPaid: bookings.amountPaid,
        tourTitle: tours.title,
        departureDateTime: tours.departureDateTime,
        returnDate: tours.returnDate,
        cancelledAt: tours.cancelledAt,
        destinationType: tours.destinationType,
        currency: tours.currency,
      })
      .from(bookingPassengers)
      .innerJoin(bookings, eq(bookingPassengers.bookingId, bookings.id))
      .innerJoin(tours, eq(bookings.tourId, tours.id))
      .where(eq(bookingPassengers.travelerId, travelerId))
      .orderBy(desc(tours.departureDateTime));

    // 3. Procesamiento de Reglas de Negocio en memoria
    // Suma total (solo para isHabitualCompanion y compatibilidad: mezcla divisas).
    let lifetimeValue = 0;
    // LTV real, por divisa: los importes de tours en MXN y en USD no se suman entre sí.
    const lifetimeValueByCurrency: Partial<
      Record<(typeof passengerRecords)[number]["currency"], number>
    > = {};
    let activeTripsCount = 0;

    const history = passengerRecords.map((record) => {
      const isCancelled =
        record.passengerStatus === "CANCELLED" || record.bookingStatus === "CANCELLED";

      if (!isCancelled) {
        activeTripsCount++;
        // El LTV solo suma si el viajero fue quien pagó (Titular)
        if (record.isTitular) {
          lifetimeValue += Number(record.amountPaid);
          lifetimeValueByCurrency[record.currency] =
            (lifetimeValueByCurrency[record.currency] ?? 0) + Number(record.amountPaid);
        }
      }

      // Estado del tour con la regla 9 (salida, regreso y cancelación, hora de CDMX): el front ya
      // no decide "Concluido" con la fecha de salida. `cancelledAt` no se envía.
      const { cancelledAt, ...trip } = record;
      return {
        ...trip,
        isCancelled, // Flag conveniente para el Front-End
        temporalStatus: getTourTemporalStatus(
          record.departureDateTime,
          cancelledAt,
          record.returnDate,
        ),
      };
    });

    return {
      ...traveler,
      metrics: {
        totalTrips: activeTripsCount,
        lifetimeValue,
        lifetimeValueByCurrency,
        isHabitualCompanion: lifetimeValue === 0 && activeTripsCount > 0,
      },
      history, // Mandamos la lista procesada en lugar del anidamiento de Drizzle
    };
  }
}
