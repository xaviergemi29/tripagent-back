import { and, asc, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DbExecutor, type DbTransaction } from "../../db/index.js";
import {
  bookingPassengers,
  bookings,
  tourHotelRoomAssignments,
  tourHotelRooms,
  tourHotels,
  tours,
  travelers,
} from "../../db/schema.js";
import {
  LODGING_ROOM_CAPACITY,
  LODGING_ROOM_STATUS,
  type LodgingRoomStatus,
  type LodgingRoomType,
} from "../../shared/constants/domain.constants.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { resolveRoomTypeForCapacity } from "../../shared/utils/lodging-room.util.js";
import { assertTourNotInAuditMode } from "../../shared/utils/tour-audit-mode.util.js";
import type {
  AssignLodgingSlotsBody,
  CreateLodgingRoomsBody,
  UpdateLodgingRoomBody,
} from "./lodging.schema.js";

const TOUR_NOT_FOUND = "Tour no encontrado";
const ROOM_NOT_FOUND = "Habitación no encontrada";
const PASSENGER_NOT_FOUND = "Pasajero no encontrado";
const SLOT_EMPTY = "No hay un pasajero asignado en esa cama";
const BED_NOT_FOUND = "Cama no encontrada";
const LAST_BED = "La habitación solo tiene un lugar: elimina la habitación completa.";
export const ROOM_NUMBER_IN_USE = "Ese número de cuarto ya está en uso en este hotel";
const SLOT_TAKEN = "Esa cama ya está ocupada";
const PASSENGER_ALREADY_HOUSED = "Ese pasajero ya tiene cama en este hotel";

export interface LodgingSlot {
  slotIndex: number;
  bookingPassengerId: string;
}

export interface LodgingRoom {
  id: string;
  roomType: LodgingRoomType;
  capacity: number;
  position: number;
  roomNumber: string | null;
  status: LodgingRoomStatus;
  slots: LodgingSlot[];
}

export interface LodgingHotel {
  id: string;
  name: string;
  createdAt: string;
  rooms: LodgingRoom[];
}

export interface LodgingPassenger {
  bookingPassengerId: string;
  bookingId: string;
  fullName: string;
  seatLabel: string | null;
  isTitular: boolean;
  groupLabel: string;
}

type RoomRow = Omit<LodgingRoom, "slots"> & { hotelId: string };
type SlotRow = LodgingSlot & { roomId: string };

/** Columnas de la habitación (lista blanca). `hotelId` se usa adentro y no sale en la respuesta. */
const ROOM_COLUMNS = {
  id: tourHotelRooms.id,
  hotelId: tourHotelRooms.hotelId,
  roomType: tourHotelRooms.roomType,
  capacity: tourHotelRooms.capacity,
  position: tourHotelRooms.position,
  roomNumber: tourHotelRooms.roomNumber,
  status: tourHotelRooms.status,
} as const;

/** Titular ACTUAL de la reserva (`bookings.travelerId`): da el nombre del grupo. */
const groupTitular = alias(travelers, "group_titular");

/**
 * Pasajero vigente del tour: ACTIVE en una reserva de la agencia, no cancelada ni borrada. Solo sus
 * asignaciones cuentan (ocupan la cama y salen en `slots`).
 */
const activePassengerWhere = (tourId: string, agencyId: string): SQL | undefined =>
  and(
    eq(bookings.tourId, tourId),
    eq(bookings.agencyId, agencyId),
    isNull(bookings.deletedAt),
    ne(bookings.status, "CANCELLED"),
    eq(bookingPassengers.status, "ACTIVE"),
  );

const sumCapacity = (rooms: readonly { capacity: number }[]): number =>
  rooms.reduce((sum, room) => sum + room.capacity, 0);

/** Mismo hotel = mismo nombre sin mayúsculas ni espacios a los lados. */
const normalizeHotelName = (name: string): string => name.trim().toLocaleLowerCase("es");

/**
 * Habitaciones a crear, en el orden del body, con la capacidad del tipo (nunca la del cliente) y la
 * posición continuando desde `startPosition`. Nacen sin número y CONSULTED.
 */
export function planRoomBatch(
  rooms: CreateLodgingRoomsBody["rooms"],
  startPosition: number,
): { roomType: LodgingRoomType; capacity: number; position: number }[] {
  const planned: { roomType: LodgingRoomType; capacity: number; position: number }[] = [];
  let position = startPosition;
  for (const { roomType, quantity } of rooms) {
    for (let i = 0; i < quantity; i += 1) {
      planned.push({ roomType, capacity: LODGING_ROOM_CAPACITY[roomType], position });
      position += 1;
    }
  }
  return planned;
}

/** Habitación de la respuesta: sin `hotelId` y con sus camas vigentes ordenadas. */
function toRoomView(room: RoomRow, slots: readonly SlotRow[]): LodgingRoom {
  return {
    id: room.id,
    roomType: room.roomType,
    capacity: room.capacity,
    position: room.position,
    roomNumber: room.roomNumber,
    status: room.status,
    slots: slots
      .filter((slot) => slot.roomId === room.id)
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map(({ slotIndex, bookingPassengerId }) => ({ slotIndex, bookingPassengerId })),
  };
}

const sortByPosition = (rooms: readonly RoomRow[]): RoomRow[] =>
  [...rooms].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

/** Camas ocupadas por pasajeros vigentes dentro de `scope` (tour, hotel o habitación). */
async function fetchActiveSlots(
  executor: DbExecutor,
  tourId: string,
  agencyId: string,
  scope: SQL,
): Promise<SlotRow[]> {
  return executor
    .select({
      roomId: tourHotelRoomAssignments.roomId,
      slotIndex: tourHotelRoomAssignments.slotIndex,
      bookingPassengerId: tourHotelRoomAssignments.bookingPassengerId,
    })
    .from(tourHotelRoomAssignments)
    .innerJoin(
      bookingPassengers,
      eq(bookingPassengers.id, tourHotelRoomAssignments.bookingPassengerId),
    )
    .innerJoin(bookings, eq(bookings.id, bookingPassengers.bookingId))
    .where(
      and(
        scope,
        eq(tourHotelRoomAssignments.agencyId, agencyId),
        activePassengerWhere(tourId, agencyId),
      ),
    );
}

/** Ids de `candidateIds` que son pasajeros vigentes del tour. */
async function fetchActivePassengerIds(
  tx: DbTransaction,
  tourId: string,
  agencyId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: bookingPassengers.id })
    .from(bookingPassengers)
    .innerJoin(bookings, eq(bookings.id, bookingPassengers.bookingId))
    .where(
      and(inArray(bookingPassengers.id, [...candidateIds]), activePassengerWhere(tourId, agencyId)),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Bloquea la fila del tour (FOR UPDATE): serializa toda mutación del hospedaje del tour. Tour ajeno
 * → 404; FINALIZADO o CANCELADO → 409 (Modo Auditoría).
 */
async function lockLodgingTour(tx: DbTransaction, tourId: string, agencyId: string) {
  const [tour] = await tx
    .select({
      id: tours.id,
      departureDateTime: tours.departureDateTime,
      returnDate: tours.returnDate,
      cancelledAt: tours.cancelledAt,
    })
    .from(tours)
    .where(and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
    .for("update");
  if (!tour) throw new NotFoundError(TOUR_NOT_FOUND);
  assertTourNotInAuditMode(tour);
}

/** Habitación del tour y de la agencia; si no, 404. */
async function findTourRoom(
  tx: DbTransaction,
  tourId: string,
  roomId: string,
  agencyId: string,
): Promise<RoomRow> {
  const [room] = await tx
    .select(ROOM_COLUMNS)
    .from(tourHotelRooms)
    .where(
      and(
        eq(tourHotelRooms.id, roomId),
        eq(tourHotelRooms.tourId, tourId),
        eq(tourHotelRooms.agencyId, agencyId),
      ),
    );
  if (!room) throw new NotFoundError(ROOM_NOT_FOUND);
  return room;
}

async function loadRoomView(
  tx: DbTransaction,
  room: RoomRow,
  tourId: string,
  agencyId: string,
): Promise<LodgingRoom> {
  const slots = await fetchActiveSlots(
    tx,
    tourId,
    agencyId,
    eq(tourHotelRoomAssignments.roomId, room.id),
  );
  return toRoomView(room, slots);
}

/**
 * Hospedaje del tour (regla 27): hoteles, habitaciones por tipo de cama y rooming list (qué pasajero
 * ocupa cada cama).
 */
export class LodgingService {
  /**
   * Hoteles del tour (por fecha de alta) con sus habitaciones (por posición) y camas vigentes,
   * pasajeros vigentes del tour y totales. Consultas acotadas, sin N+1.
   */
  static async getTourLodging(tourId: string, agencyId: string) {
    const [tour] = await db
      .select({ id: tours.id })
      .from(tours)
      .where(and(eq(tours.id, tourId), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)));
    if (!tour) throw new NotFoundError(TOUR_NOT_FOUND);

    const [hotelRows, roomRows, passengers, slots] = await Promise.all([
      db
        .select({ id: tourHotels.id, name: tourHotels.name, createdAt: tourHotels.createdAt })
        .from(tourHotels)
        .where(and(eq(tourHotels.tourId, tourId), eq(tourHotels.agencyId, agencyId)))
        .orderBy(asc(tourHotels.createdAt), asc(tourHotels.id)),
      db
        .select(ROOM_COLUMNS)
        .from(tourHotelRooms)
        .where(and(eq(tourHotelRooms.tourId, tourId), eq(tourHotelRooms.agencyId, agencyId))),
      LodgingService.listActivePassengers(tourId, agencyId),
      fetchActiveSlots(db, tourId, agencyId, eq(tourHotelRoomAssignments.tourId, tourId)),
    ]);

    const rooms = sortByPosition(roomRows);
    const hotels: LodgingHotel[] = hotelRows.map((hotel) => ({
      id: hotel.id,
      name: hotel.name,
      createdAt: hotel.createdAt,
      rooms: rooms
        .filter((room) => room.hotelId === hotel.id)
        .map((room) => toRoomView(room, slots)),
    }));
    const allRooms = hotels.flatMap((hotel) => hotel.rooms);

    return {
      hotels,
      passengers,
      totalRooms: allRooms.length,
      totalCapacity: sumCapacity(allRooms),
    };
  }

  /**
   * Pasajeros vigentes del tour para la rooming list: solo nombre, asiento, titular y grupo (nombre
   * del titular actual). Nunca teléfonos, correos ni montos. Orden: por reserva y titular primero.
   */
  static async listActivePassengers(tourId: string, agencyId: string): Promise<LodgingPassenger[]> {
    return db
      .select({
        bookingPassengerId: bookingPassengers.id,
        bookingId: bookingPassengers.bookingId,
        fullName: travelers.fullName,
        seatLabel: bookingPassengers.seatLabel,
        isTitular: bookingPassengers.isTitular,
        groupLabel: groupTitular.fullName,
      })
      .from(bookingPassengers)
      .innerJoin(bookings, eq(bookings.id, bookingPassengers.bookingId))
      .innerJoin(travelers, eq(travelers.id, bookingPassengers.travelerId))
      .innerJoin(groupTitular, eq(groupTitular.id, bookings.travelerId))
      .where(activePassengerWhere(tourId, agencyId))
      .orderBy(
        asc(bookings.createdAt),
        asc(bookings.id),
        desc(bookingPassengers.isTitular),
        asc(bookingPassengers.createdAt),
        asc(bookingPassengers.id),
      );
  }

  /**
   * Crea en lote las habitaciones de un hotel del tour. Si ya existe un hotel con el mismo nombre
   * (sin mayúsculas ni espacios a los lados) se le agregan; si no, se crea. Nacen sin número,
   * CONSULTED y con `position` continuando desde la mayor del hotel. Tour bloqueado (FOR UPDATE).
   */
  static async createRooms(
    tourId: string,
    body: CreateLodgingRoomsBody,
    agencyId: string,
    userId: string,
  ) {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);

      // Pocos hoteles por tour: se comparan los nombres en memoria con la misma normalización.
      const tourHotelRows = await tx
        .select({ id: tourHotels.id, name: tourHotels.name, createdAt: tourHotels.createdAt })
        .from(tourHotels)
        .where(and(eq(tourHotels.tourId, tourId), eq(tourHotels.agencyId, agencyId)));

      const wantedName = normalizeHotelName(body.hotelName);
      const existingHotel = tourHotelRows.find(
        (hotel) => normalizeHotelName(hotel.name) === wantedName,
      );
      const now = new Date().toISOString();

      let hotel = existingHotel;
      let existingRooms: RoomRow[] = [];
      let existingSlots: SlotRow[] = [];
      if (existingHotel) {
        existingRooms = await tx
          .select(ROOM_COLUMNS)
          .from(tourHotelRooms)
          .where(
            and(
              eq(tourHotelRooms.hotelId, existingHotel.id),
              eq(tourHotelRooms.agencyId, agencyId),
            ),
          );
        existingSlots = await fetchActiveSlots(
          tx,
          tourId,
          agencyId,
          eq(tourHotelRoomAssignments.hotelId, existingHotel.id),
        );
        await tx
          .update(tourHotels)
          .set({ updatedAt: now })
          .where(and(eq(tourHotels.id, existingHotel.id), eq(tourHotels.agencyId, agencyId)));
      } else {
        [hotel] = await tx
          .insert(tourHotels)
          .values({
            agencyId,
            tourId,
            name: body.hotelName,
            createdByUserId: userId,
            updatedAt: now,
          })
          .returning({ id: tourHotels.id, name: tourHotels.name, createdAt: tourHotels.createdAt });
      }
      if (!hotel) throw new Error("No se pudo registrar el hotel");
      const hotelId = hotel.id;

      const lastPosition = existingRooms.reduce((max, room) => Math.max(max, room.position), 0);
      const planned = planRoomBatch(body.rooms, lastPosition + 1);
      const createdRooms = await tx
        .insert(tourHotelRooms)
        .values(
          planned.map((room) => ({
            ...room,
            agencyId,
            tourId,
            hotelId,
            roomNumber: null,
            status: LODGING_ROOM_STATUS.CONSULTED,
            updatedAt: now,
          })),
        )
        .returning(ROOM_COLUMNS);

      return {
        hotel: {
          id: hotel.id,
          name: hotel.name,
          createdAt: hotel.createdAt,
          rooms: sortByPosition([...existingRooms, ...createdRooms]).map((room) =>
            toRoomView(room, existingSlots),
          ),
        },
        createdRooms: createdRooms.length,
        createdCapacity: sumCapacity(createdRooms),
      };
    });
  }

  /**
   * Cambia el número de cuarto (null = quitarlo) o el estado de una habitación. Número repetido en
   * el mismo hotel → 409 (la ruta también traduce el 23505 del índice único).
   */
  static async updateRoom(
    tourId: string,
    roomId: string,
    body: UpdateLodgingRoomBody,
    agencyId: string,
  ): Promise<LodgingRoom> {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);
      const room = await findTourRoom(tx, tourId, roomId, agencyId);

      const changes: { roomNumber?: string | null; status?: LodgingRoomStatus } = {};
      if (body.roomNumber !== undefined) changes.roomNumber = body.roomNumber;
      if (body.status !== undefined) changes.status = body.status;

      if (changes.roomNumber) {
        const [duplicate] = await tx
          .select({ id: tourHotelRooms.id })
          .from(tourHotelRooms)
          .where(
            and(
              eq(tourHotelRooms.hotelId, room.hotelId),
              eq(tourHotelRooms.agencyId, agencyId),
              eq(tourHotelRooms.roomNumber, changes.roomNumber),
              ne(tourHotelRooms.id, room.id),
            ),
          );
        if (duplicate) throw new ConflictError(ROOM_NUMBER_IN_USE);
      }

      await tx
        .update(tourHotelRooms)
        .set({ ...changes, updatedAt: new Date().toISOString() })
        .where(and(eq(tourHotelRooms.id, room.id), eq(tourHotelRooms.agencyId, agencyId)));

      return loadRoomView(tx, { ...room, ...changes }, tourId, agencyId);
    });
  }

  /**
   * Asigna uno o varios pasajeros a camas de una habitación (todo o nada). Cama fuera de la
   * capacidad → 400; pasajero no vigente del tour → 404; cama ocupada por un pasajero vigente o
   * pasajero vigente con cama en el mismo hotel → 409. Las asignaciones NO vigentes que estorben
   * (misma cama o mismo pasajero en el hotel) se borran antes de insertar.
   */
  static async assignSlots(
    tourId: string,
    roomId: string,
    body: AssignLodgingSlotsBody,
    agencyId: string,
    userId: string,
  ): Promise<LodgingRoom> {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);
      const room = await findTourRoom(tx, tourId, roomId, agencyId);

      const outOfRange = body.assignments.find((item) => item.slotIndex > room.capacity);
      if (outOfRange) {
        throw new BusinessRuleError(
          `La cama ${outOfRange.slotIndex} no existe: la habitación es para ${room.capacity} personas`,
        );
      }

      const requestedSlots = new Set(body.assignments.map((item) => item.slotIndex));
      const requestedPassengers = new Set(body.assignments.map((item) => item.bookingPassengerId));

      // Asignaciones del hotel que chocan con el envío (misma cama o mismo pasajero).
      const hotelAssignments = await tx
        .select({
          id: tourHotelRoomAssignments.id,
          roomId: tourHotelRoomAssignments.roomId,
          slotIndex: tourHotelRoomAssignments.slotIndex,
          bookingPassengerId: tourHotelRoomAssignments.bookingPassengerId,
        })
        .from(tourHotelRoomAssignments)
        .where(
          and(
            eq(tourHotelRoomAssignments.hotelId, room.hotelId),
            eq(tourHotelRoomAssignments.agencyId, agencyId),
          ),
        );
      const blockers = hotelAssignments.filter(
        (row) =>
          (row.roomId === room.id && requestedSlots.has(row.slotIndex)) ||
          requestedPassengers.has(row.bookingPassengerId),
      );

      const active = await fetchActivePassengerIds(tx, tourId, agencyId, [
        ...new Set([...requestedPassengers, ...blockers.map((row) => row.bookingPassengerId)]),
      ]);
      if ([...requestedPassengers].some((id) => !active.has(id))) {
        throw new NotFoundError(PASSENGER_NOT_FOUND);
      }

      const activeBlockers = blockers.filter((row) => active.has(row.bookingPassengerId));
      const slotTaken = activeBlockers.some(
        (row) => row.roomId === room.id && requestedSlots.has(row.slotIndex),
      );
      if (slotTaken) throw new ConflictError(SLOT_TAKEN);
      if (activeBlockers.length > 0) throw new ConflictError(PASSENGER_ALREADY_HOUSED);

      // Solo quedan asignaciones NO vigentes que estorban: se reemplazan.
      const staleIds = blockers.map((row) => row.id);
      if (staleIds.length > 0) {
        await tx
          .delete(tourHotelRoomAssignments)
          .where(
            and(
              inArray(tourHotelRoomAssignments.id, staleIds),
              eq(tourHotelRoomAssignments.agencyId, agencyId),
            ),
          );
      }

      await tx.insert(tourHotelRoomAssignments).values(
        body.assignments.map((item) => ({
          agencyId,
          tourId,
          hotelId: room.hotelId,
          roomId: room.id,
          slotIndex: item.slotIndex,
          bookingPassengerId: item.bookingPassengerId,
          assignedByUserId: userId,
        })),
      );

      return loadRoomView(tx, room, tourId, agencyId);
    });
  }

  /** Libera una cama (el pasajero vuelve a "sin habitación"). Sin asignación → 404. */
  static async unassignSlot(
    tourId: string,
    roomId: string,
    slotIndex: number,
    agencyId: string,
  ): Promise<LodgingRoom> {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);
      const room = await findTourRoom(tx, tourId, roomId, agencyId);

      const deleted = await tx
        .delete(tourHotelRoomAssignments)
        .where(
          and(
            eq(tourHotelRoomAssignments.roomId, room.id),
            eq(tourHotelRoomAssignments.slotIndex, slotIndex),
            eq(tourHotelRoomAssignments.agencyId, agencyId),
          ),
        )
        .returning({ id: tourHotelRoomAssignments.id });
      if (deleted.length === 0) throw new NotFoundError(SLOT_EMPTY);

      return loadRoomView(tx, room, tourId, agencyId);
    });
  }

  /**
   * Elimina una habitación (borrado físico; sus camas asignadas se borran por cascade). Los pasajeros
   * vuelven a "sin habitación". El hotel se conserva aunque quede vacío y las demás habitaciones no
   * se renumeran (la `position` puede quedar con huecos). `releasedPassengers` = asignaciones
   * vigentes que tenía.
   */
  static async deleteRoom(
    tourId: string,
    roomId: string,
    agencyId: string,
  ): Promise<{ deletedRoomId: string; releasedPassengers: number }> {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);
      const room = await findTourRoom(tx, tourId, roomId, agencyId);
      const activeSlots = await fetchActiveSlots(
        tx,
        tourId,
        agencyId,
        eq(tourHotelRoomAssignments.roomId, room.id),
      );

      await tx
        .delete(tourHotelRooms)
        .where(and(eq(tourHotelRooms.id, room.id), eq(tourHotelRooms.agencyId, agencyId)));

      return { deletedRoomId: room.id, releasedPassengers: activeSlots.length };
    });
  }

  /**
   * Elimina una cama: borra su asignación (vigente o no), recorre las camas siguientes un lugar
   * hacia abajo conservando a sus pasajeros y baja la capacidad en 1. El tipo de habitación no
   * cambia (la capacidad puede quedar por debajo de la del tipo). Cama fuera de la capacidad → 404;
   * habitación de un solo lugar → 409 (se elimina la habitación completa).
   */
  static async deleteBed(
    tourId: string,
    roomId: string,
    slotIndex: number,
    agencyId: string,
  ): Promise<{ room: LodgingRoom; releasedPassenger: boolean }> {
    return db.transaction(async (tx) => {
      await lockLodgingTour(tx, tourId, agencyId);
      const room = await findTourRoom(tx, tourId, roomId, agencyId);
      if (slotIndex > room.capacity) throw new NotFoundError(BED_NOT_FOUND);
      if (room.capacity <= 1) throw new ConflictError(LAST_BED);

      const activeSlots = await fetchActiveSlots(
        tx,
        tourId,
        agencyId,
        eq(tourHotelRoomAssignments.roomId, room.id),
      );
      const releasedPassenger = activeSlots.some((slot) => slot.slotIndex === slotIndex);

      const roomScope = and(
        eq(tourHotelRoomAssignments.roomId, room.id),
        eq(tourHotelRoomAssignments.agencyId, agencyId),
      );
      await tx
        .delete(tourHotelRoomAssignments)
        .where(and(roomScope, eq(tourHotelRoomAssignments.slotIndex, slotIndex)));

      // Recorre las camas siguientes de una en una y en orden ascendente: cada fila baja a una cama
      // que ya quedó libre, así nunca choca con el índice único (roomId, slotIndex).
      const roomAssignments = await tx
        .select({ id: tourHotelRoomAssignments.id, slotIndex: tourHotelRoomAssignments.slotIndex })
        .from(tourHotelRoomAssignments)
        .where(roomScope);
      const toShift = roomAssignments
        .filter((row) => row.slotIndex > slotIndex)
        .sort((a, b) => a.slotIndex - b.slotIndex);
      for (const row of toShift) {
        await tx
          .update(tourHotelRoomAssignments)
          .set({ slotIndex: row.slotIndex - 1 })
          .where(
            and(
              eq(tourHotelRoomAssignments.id, row.id),
              eq(tourHotelRoomAssignments.agencyId, agencyId),
            ),
          );
      }

      // La habitación pasa al tipo de su nueva capacidad (Matrimonial con 1 lugar → Individual).
      const capacity = room.capacity - 1;
      const roomType = resolveRoomTypeForCapacity(room.roomType, capacity);
      await tx
        .update(tourHotelRooms)
        .set({ capacity, roomType, updatedAt: new Date().toISOString() })
        .where(and(eq(tourHotelRooms.id, room.id), eq(tourHotelRooms.agencyId, agencyId)));

      return {
        room: await loadRoomView(tx, { ...room, capacity, roomType }, tourId, agencyId),
        releasedPassenger,
      };
    });
  }
}
