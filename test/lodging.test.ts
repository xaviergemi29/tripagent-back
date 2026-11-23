import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { LODGING_ROOM_CAPACITY } from "../src/shared/constants/domain.constants.js";
import { planRoomBatch } from "../src/modules/lodging/lodging.service.js";
import { createLodgingRoomsBodySchema } from "../src/modules/lodging/lodging.schema.js";
import { resolveRoomTypeForCapacity } from "../src/shared/utils/lodging-room.util.js";
import { createFakeLodgingDb, type LodgingTables } from "./fake-lodging-db.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  createTestApp,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

// Hospedaje del tour (regla 27): hoteles, habitaciones y rooming list.

type Row = Record<string, unknown>;
type LodgingSlotRow = { slotIndex: number; bookingPassengerId: string };

const uuid = (prefix: string, n: number) =>
  `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const TOUR_ID = uuid("e", 1);
const OTHER_TOUR_ID = uuid("e", 2);
const HOTEL_1 = uuid("f", 1);
const HOTEL_2 = uuid("f", 2);
const OTHER_TOUR_HOTEL = uuid("f", 3);
const ROOM_MAT = uuid("c", 1);
const ROOM_DOUBLE = uuid("c", 2);
const ROOM_TRIPLE_H2 = uuid("c", 3);
const ROOM_OTHER_TOUR = uuid("c", 4);
const ROOM_MAT_2 = uuid("c", 5);

// Pasajeros (booking_passengers.id)
const P_TITULAR = uuid("d", 1); // Ana Pérez, titular de la reserva 1
const P_COMPANION = uuid("d", 2); // Luis Pérez, acompañante de la reserva 1
const P_SOLO = uuid("d", 3); // Carla Ruiz, titular de la reserva 2
const P_DROPPED = uuid("d", 4); // dado de baja (CANCELLED) en la reserva 1
const P_CANCELLED_BOOKING = uuid("d", 5); // ACTIVE en una reserva cancelada
const P_DELETED_BOOKING = uuid("d", 6); // ACTIVE en una reserva borrada
const P_OTHER_TOUR = uuid("d", 7); // de otro tour

const tour = (id: string, overrides: Row = {}): Row => ({
  id,
  agencyId: AGENCY_A,
  deletedAt: null,
  departureDateTime: "2099-03-10",
  returnDate: "2099-03-12",
  cancelledAt: null,
  ...overrides,
});

const traveler = (n: number, fullName: string): Row => ({
  id: uuid("b", n),
  agencyId: AGENCY_A,
  fullName,
  whatsappPhone: `+52228123450${n}`,
  email: `viajero${n}@example.com`,
  emergencyContactPhone: "+522281111111",
  birthDate: "1990-01-01",
});

const booking = (n: number, travelerN: number, overrides: Row = {}): Row => ({
  id: uuid("a", n),
  agencyId: AGENCY_A,
  tourId: TOUR_ID,
  travelerId: uuid("b", travelerN),
  status: "CONFIRMED",
  totalPrice: 9000,
  amountPaid: 4500,
  deletedAt: null,
  createdAt: `2026-11-0${n}T10:00:00.000Z`,
  ...overrides,
});

const passenger = (id: string, bookingN: number, travelerN: number, overrides: Row = {}): Row => ({
  id,
  bookingId: uuid("a", bookingN),
  travelerId: uuid("b", travelerN),
  isTitular: false,
  status: "ACTIVE",
  seatLabel: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

const room = (id: string, hotelId: string, overrides: Row = {}): Row => ({
  id,
  agencyId: AGENCY_A,
  tourId: TOUR_ID,
  hotelId,
  roomType: "MATRIMONIAL",
  capacity: 2,
  position: 1,
  roomNumber: null,
  status: "CONSULTED",
  ...overrides,
});

const assignment = (roomId: string, hotelId: string, slotIndex: number, bpId: string): Row => ({
  id: `${roomId}-${slotIndex}`,
  agencyId: AGENCY_A,
  tourId: TOUR_ID,
  hotelId,
  roomId,
  slotIndex,
  bookingPassengerId: bpId,
});

function baseTables(overrides: Partial<LodgingTables> = {}): Partial<LodgingTables> {
  return {
    tours: [tour(TOUR_ID), tour(OTHER_TOUR_ID)],
    travelers: [
      traveler(1, "Ana Pérez"),
      traveler(2, "Luis Pérez"),
      traveler(3, "Carla Ruiz"),
      traveler(4, "Dado De Baja"),
      traveler(5, "Reserva Cancelada"),
      traveler(6, "Reserva Borrada"),
      traveler(7, "Otro Tour"),
    ],
    bookings: [
      booking(2, 3, { status: "PENDING" }),
      booking(1, 1),
      booking(3, 5, { status: "CANCELLED" }),
      booking(4, 6, { deletedAt: "2026-11-05T10:00:00.000Z" }),
      booking(5, 7, { tourId: OTHER_TOUR_ID }),
    ],
    // El acompañante va antes en el arreglo: el orden lo decide la consulta (titular primero).
    booking_passengers: [
      passenger(P_COMPANION, 1, 2),
      passenger(P_TITULAR, 1, 1, { isTitular: true, seatLabel: "4A" }),
      passenger(P_SOLO, 2, 3, { isTitular: true, seatLabel: "7" }),
      passenger(P_DROPPED, 1, 4, { status: "CANCELLED" }),
      passenger(P_CANCELLED_BOOKING, 3, 5, { isTitular: true }),
      passenger(P_DELETED_BOOKING, 4, 6, { isTitular: true }),
      passenger(P_OTHER_TOUR, 5, 7, { isTitular: true }),
    ],
    tour_hotels: [
      {
        id: HOTEL_1,
        agencyId: AGENCY_A,
        tourId: TOUR_ID,
        name: "Hotel Real",
        createdAt: "2026-11-20T10:00:00.000Z",
      },
      {
        id: HOTEL_2,
        agencyId: AGENCY_A,
        tourId: TOUR_ID,
        name: "Hotel Mar",
        createdAt: "2026-11-21T10:00:00.000Z",
      },
      {
        id: OTHER_TOUR_HOTEL,
        agencyId: AGENCY_A,
        tourId: OTHER_TOUR_ID,
        name: "Otro",
        createdAt: "2026-11-21T10:00:00.000Z",
      },
    ],
    tour_hotel_rooms: [
      room(ROOM_DOUBLE, HOTEL_1, { roomType: "DOUBLE_INDIVIDUAL", position: 2 }),
      room(ROOM_MAT, HOTEL_1, { position: 1, roomNumber: "101" }),
      room(ROOM_MAT_2, HOTEL_1, { position: 3 }),
      room(ROOM_TRIPLE_H2, HOTEL_2, { roomType: "TRIPLE", capacity: 3, position: 1 }),
      room(ROOM_OTHER_TOUR, OTHER_TOUR_HOTEL, { tourId: OTHER_TOUR_ID }),
    ],
    tour_hotel_room_assignments: [],
    ...overrides,
  };
}

describe("resolveRoomTypeForCapacity", () => {
  it("conserva el tipo si la capacidad coincide con la de su tipo", () => {
    assert.equal(resolveRoomTypeForCapacity("MATRIMONIAL", 2), "MATRIMONIAL");
    assert.equal(resolveRoomTypeForCapacity("DOUBLE_INDIVIDUAL", 2), "DOUBLE_INDIVIDUAL");
    assert.equal(resolveRoomTypeForCapacity("TRIPLE", 3), "TRIPLE");
    assert.equal(resolveRoomTypeForCapacity("QUADRUPLE", 4), "QUADRUPLE");
    assert.equal(resolveRoomTypeForCapacity("SINGLE", 1), "SINGLE");
  });

  it("si no coincide, toma el tipo de la nueva capacidad (2 lugares → Doble Individual)", () => {
    assert.equal(resolveRoomTypeForCapacity("MATRIMONIAL", 1), "SINGLE");
    assert.equal(resolveRoomTypeForCapacity("DOUBLE_INDIVIDUAL", 1), "SINGLE");
    assert.equal(resolveRoomTypeForCapacity("TRIPLE", 2), "DOUBLE_INDIVIDUAL");
    assert.equal(resolveRoomTypeForCapacity("QUADRUPLE", 3), "TRIPLE");
    assert.equal(resolveRoomTypeForCapacity("QUADRUPLE", 2), "DOUBLE_INDIVIDUAL");
    assert.equal(resolveRoomTypeForCapacity("TRIPLE", 1), "SINGLE");
  });

  it("capacidad fuera de 1..4 conserva el tipo actual", () => {
    assert.equal(resolveRoomTypeForCapacity("TRIPLE", 0), "TRIPLE");
    assert.equal(resolveRoomTypeForCapacity("QUADRUPLE", 5), "QUADRUPLE");
  });
});

describe("planRoomBatch", () => {
  it("continúa la posición en el orden del body con la capacidad del tipo", () => {
    assert.deepEqual(
      planRoomBatch(
        [
          { roomType: "MATRIMONIAL", quantity: 2 },
          { roomType: "QUADRUPLE", quantity: 1 },
        ],
        4,
      ),
      [
        { roomType: "MATRIMONIAL", capacity: 2, position: 4 },
        { roomType: "MATRIMONIAL", capacity: 2, position: 5 },
        { roomType: "QUADRUPLE", capacity: 4, position: 6 },
      ],
    );
  });
});

describe("Hospedaje del tour: /api/lodging", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = (agencyId = AGENCY_A) => sessionCookie(app, agencyId, USER_A);
  const roomUrl = (roomId: string, tourId = TOUR_ID) => `/api/lodging/${tourId}/rooms/${roomId}`;

  const getLodging = (agencyId = AGENCY_A) =>
    app.inject({ method: "GET", url: `/api/lodging/${TOUR_ID}`, cookies: cookies(agencyId) });

  const postRooms = (payload: unknown, agencyId = AGENCY_A) =>
    app.inject({
      method: "POST",
      url: `/api/lodging/${TOUR_ID}/rooms`,
      cookies: cookies(agencyId),
      payload: payload as Row,
    });

  const patchRoom = (roomId: string, payload: unknown, agencyId = AGENCY_A, tourId = TOUR_ID) =>
    app.inject({
      method: "PATCH",
      url: roomUrl(roomId, tourId),
      cookies: cookies(agencyId),
      payload: payload as Row,
    });

  const assign = (roomId: string, assignments: unknown, agencyId = AGENCY_A, tourId = TOUR_ID) =>
    app.inject({
      method: "POST",
      url: `${roomUrl(roomId, tourId)}/assignments`,
      cookies: cookies(agencyId),
      payload: { assignments } as Row,
    });

  const unassign = (roomId: string, slotIndex: number | string, agencyId = AGENCY_A) =>
    app.inject({
      method: "DELETE",
      url: `${roomUrl(roomId)}/slots/${slotIndex}`,
      cookies: cookies(agencyId),
    });

  const deleteRoom = (roomId: string, agencyId = AGENCY_A, tourId = TOUR_ID) =>
    app.inject({ method: "DELETE", url: roomUrl(roomId, tourId), cookies: cookies(agencyId) });

  const deleteBed = (
    roomId: string,
    slotIndex: number | string,
    agencyId = AGENCY_A,
    tourId = TOUR_ID,
  ) =>
    app.inject({
      method: "DELETE",
      url: `${roomUrl(roomId, tourId)}/beds/${slotIndex}`,
      cookies: cookies(agencyId),
    });

  const writesOf = (fake: ReturnType<typeof createFakeLodgingDb>) =>
    fake.writes.filter((write) => write.table !== "tours");

  it("sin sesión → 401", async () => {
    for (const [method, url] of [
      ["GET", `/api/lodging/${TOUR_ID}`],
      ["POST", `/api/lodging/${TOUR_ID}/rooms`],
      ["PATCH", roomUrl(ROOM_MAT)],
      ["POST", `${roomUrl(ROOM_MAT)}/assignments`],
      ["DELETE", `${roomUrl(ROOM_MAT)}/slots/1`],
      ["DELETE", roomUrl(ROOM_MAT)],
      ["DELETE", `${roomUrl(ROOM_MAT)}/beds/1`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  describe("GET /lodging/:tourId", () => {
    it("tour sin hoteles ni reservas → listas vacías y totales en 0", async () => {
      createFakeLodgingDb({ tours: [tour(TOUR_ID)] });
      const res = await getLodging();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), {
        data: { hotels: [], passengers: [], totalRooms: 0, totalCapacity: 0 },
      });
    });

    it("hoteles del tour con habitaciones por posición, campos nuevos y totales", async () => {
      createFakeLodgingDb(baseTables());
      const res = await getLodging();
      assert.equal(res.statusCode, 200);
      const { data } = res.json();

      assert.deepEqual(
        data.hotels.map((hotel: Row) => hotel.id),
        [HOTEL_1, HOTEL_2],
      );
      const [hotel1] = data.hotels;
      assert.deepEqual(Object.keys(hotel1).sort(), ["createdAt", "id", "name", "rooms"]);
      assert.deepEqual(
        hotel1.rooms.map((r: Row) => r.id),
        [ROOM_MAT, ROOM_DOUBLE, ROOM_MAT_2],
      );
      assert.deepEqual(hotel1.rooms[0], {
        id: ROOM_MAT,
        roomType: "MATRIMONIAL",
        capacity: 2,
        position: 1,
        roomNumber: "101",
        status: "CONSULTED",
        slots: [],
      });
      assert.equal(data.totalRooms, 4);
      assert.equal(data.totalCapacity, 2 + 2 + 2 + 3);
    });

    it("passengers: solo vigentes, titular primero, grupo = titular actual y sin datos de contacto", async () => {
      createFakeLodgingDb(baseTables());
      const res = await getLodging();
      const { passengers } = res.json().data;

      assert.deepEqual(passengers, [
        {
          bookingPassengerId: P_TITULAR,
          bookingId: uuid("a", 1),
          fullName: "Ana Pérez",
          seatLabel: "4A",
          isTitular: true,
          groupLabel: "Ana Pérez",
        },
        {
          bookingPassengerId: P_COMPANION,
          bookingId: uuid("a", 1),
          fullName: "Luis Pérez",
          seatLabel: null,
          isTitular: false,
          groupLabel: "Ana Pérez",
        },
        {
          bookingPassengerId: P_SOLO,
          bookingId: uuid("a", 2),
          fullName: "Carla Ruiz",
          seatLabel: "7",
          isTitular: true,
          groupLabel: "Carla Ruiz",
        },
      ]);
      const serialized = res.body;
      for (const leaked of ["+52", "@example.com", "1990-01-01", "9000", "4500", "totalPrice"]) {
        assert.ok(!serialized.includes(leaked), `la respuesta no debe incluir ${leaked}`);
      }
    });

    it("groupLabel sigue al titular ACTUAL de la reserva (tras una transferencia)", async () => {
      const tables = baseTables();
      tables.bookings = tables.bookings!.map((row) =>
        row.id === uuid("a", 1) ? { ...row, travelerId: uuid("b", 2) } : row,
      );
      createFakeLodgingDb(tables);
      const { passengers } = (await getLodging()).json().data;
      assert.equal(passengers[0].groupLabel, "Luis Pérez");
    });

    it("slots: solo asignaciones vigentes, ordenadas por cama", async () => {
      createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [
            assignment(ROOM_DOUBLE, HOTEL_1, 2, P_TITULAR),
            assignment(ROOM_DOUBLE, HOTEL_1, 1, P_SOLO),
            assignment(ROOM_MAT, HOTEL_1, 1, P_DROPPED),
            assignment(ROOM_MAT, HOTEL_1, 2, P_CANCELLED_BOOKING),
            assignment(ROOM_MAT_2, HOTEL_1, 1, P_DELETED_BOOKING),
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 3, P_TITULAR),
          ],
        }),
      );
      const { data } = (await getLodging()).json();
      const rooms = Object.fromEntries(
        data.hotels.flatMap((hotel: { rooms: Row[] }) => hotel.rooms.map((r) => [r.id, r.slots])),
      );
      assert.deepEqual(rooms[ROOM_DOUBLE], [
        { slotIndex: 1, bookingPassengerId: P_SOLO },
        { slotIndex: 2, bookingPassengerId: P_TITULAR },
      ]);
      assert.deepEqual(rooms[ROOM_MAT], []);
      assert.deepEqual(rooms[ROOM_MAT_2], []);
      assert.deepEqual(rooms[ROOM_TRIPLE_H2], [{ slotIndex: 3, bookingPassengerId: P_TITULAR }]);
    });

    it("tour ajeno → 404", async () => {
      createFakeLodgingDb(baseTables());
      const res = await getLodging(AGENCY_B);
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, "Tour no encontrado");
    });
  });

  describe("POST /lodging/:tourId/rooms", () => {
    it("crea el hotel con habitaciones sin número, CONSULTED y posición 1..n en el orden del body", async () => {
      const fake = createFakeLodgingDb({ tours: [tour(TOUR_ID)] });

      const res = await postRooms({
        hotelName: "  Hotel Nuevo  ",
        rooms: [
          { roomType: "MATRIMONIAL", quantity: 2 },
          { roomType: "DOUBLE_INDIVIDUAL", quantity: 2 },
        ],
      });

      assert.equal(res.statusCode, 201);
      const { data } = res.json();
      assert.equal(data.hotel.name, "Hotel Nuevo");
      assert.equal(data.createdRooms, 4);
      assert.equal(data.createdCapacity, 8);
      assert.deepEqual(
        data.hotel.rooms.map((r: Row) => [
          r.position,
          r.roomType,
          r.capacity,
          r.roomNumber,
          r.status,
        ]),
        [
          [1, "MATRIMONIAL", 2, null, "CONSULTED"],
          [2, "MATRIMONIAL", 2, null, "CONSULTED"],
          [3, "DOUBLE_INDIVIDUAL", 2, null, "CONSULTED"],
          [4, "DOUBLE_INDIVIDUAL", 2, null, "CONSULTED"],
        ],
      );
      assert.deepEqual(Object.keys(data.hotel.rooms[0]).sort(), [
        "capacity",
        "id",
        "position",
        "roomNumber",
        "roomType",
        "slots",
        "status",
      ]);
      const hotelInsert = fake.writes.find((w) => w.table === "tour_hotels")?.values as Row;
      assert.equal(hotelInsert.createdByUserId, USER_A);
      assert.equal(hotelInsert.agencyId, AGENCY_A);
      const roomInsert = fake.writes.find((w) => w.table === "tour_hotel_rooms")?.values as Row[];
      assert.ok(roomInsert.every((r) => r.agencyId === AGENCY_A && r.tourId === TOUR_ID));
    });

    it("mismo nombre (otra capitalización) agrega al hotel y la posición continúa desde la mayor", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 1, P_TITULAR)],
        }),
      );

      const res = await postRooms({
        hotelName: " hotel REAL ",
        rooms: [{ roomType: "QUADRUPLE", quantity: 2 }],
      });

      assert.equal(res.statusCode, 201);
      const { data } = res.json();
      assert.equal(data.hotel.id, HOTEL_1);
      assert.equal(data.hotel.name, "Hotel Real");
      assert.deepEqual(
        data.hotel.rooms.map((r: Row) => [r.position, r.roomNumber]),
        [
          [1, "101"],
          [2, null],
          [3, null],
          [4, null],
          [5, null],
        ],
      );
      assert.deepEqual(data.hotel.rooms[0].slots, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
      ]);
      assert.equal(data.createdRooms, 2);
      assert.equal(data.createdCapacity, 8);
      assert.equal(
        fake.writes.filter((w) => w.table === "tour_hotels" && w.op === "insert").length,
        0,
      );
    });

    it("la capacidad la decide el servidor aunque el body traiga otra", async () => {
      createFakeLodgingDb({ tours: [tour(TOUR_ID)] });
      const res = await postRooms({
        hotelName: "Hotel",
        rooms: [{ roomType: "TRIPLE", quantity: 1, capacityPerRoom: 99, capacity: 99 }],
        totalCapacity: 99,
      });
      assert.equal(res.statusCode, 201);
      const { data } = res.json();
      assert.equal(data.hotel.rooms[0].capacity, LODGING_ROOM_CAPACITY.TRIPLE);
      assert.equal(data.createdCapacity, 3);
    });

    it("400 por body inválido sin abrir la transacción", async () => {
      const fake = createFakeLodgingDb({ tours: [tour(TOUR_ID)] });
      const invalidBodies = [
        { hotelName: "Hotel", rooms: [] },
        {
          hotelName: "Hotel",
          rooms: [
            { roomType: "TRIPLE", quantity: 1 },
            { roomType: "TRIPLE", quantity: 2 },
          ],
        },
        { hotelName: "Hotel", rooms: [{ roomType: "TRIPLE", quantity: 0 }] },
        { hotelName: "Hotel", rooms: [{ roomType: "TRIPLE", quantity: 51 }] },
        { hotelName: "   ", rooms: [{ roomType: "TRIPLE", quantity: 1 }] },
        { hotelName: "Hotel", rooms: [{ roomType: "SUITE", quantity: 1 }] },
      ];
      for (const body of invalidBodies) {
        const res = await postRooms(body);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
      }
      assert.equal(fake.transaction.mock.callCount(), 0);
    });

    it("tope de 200: 4 tipos × 50 (justo el tope) es válido", () => {
      const result = createLodgingRoomsBodySchema.safeParse({
        hotelName: "Hotel",
        rooms: [
          { roomType: "MATRIMONIAL", quantity: 50 },
          { roomType: "DOUBLE_INDIVIDUAL", quantity: 50 },
          { roomType: "TRIPLE", quantity: 50 },
          { roomType: "QUADRUPLE", quantity: 50 },
        ],
      });
      assert.equal(result.success, true);
    });

    it("crea habitaciones SINGLE con capacidad 1 del servidor, junto con los otros 4 tipos", async () => {
      createFakeLodgingDb({ tours: [tour(TOUR_ID)] });
      const res = await postRooms({
        hotelName: "Hotel Individual",
        rooms: [
          { roomType: "SINGLE", quantity: 2 },
          { roomType: "MATRIMONIAL", quantity: 1 },
          { roomType: "DOUBLE_INDIVIDUAL", quantity: 1 },
          { roomType: "TRIPLE", quantity: 1 },
          { roomType: "QUADRUPLE", quantity: 1 },
        ],
      });
      assert.equal(res.statusCode, 201);
      const { data } = res.json();
      assert.equal(data.createdRooms, 6);
      assert.equal(data.createdCapacity, 1 + 1 + 2 + 2 + 3 + 4);
      assert.deepEqual(
        data.hotel.rooms.slice(0, 2).map((r: Row) => [r.roomType, r.capacity]),
        [
          ["SINGLE", LODGING_ROOM_CAPACITY.SINGLE],
          ["SINGLE", 1],
        ],
      );
    });

    it("con 5 tipos el tope de 200 por envío se sigue aplicando", () => {
      const rooms = ["SINGLE", "MATRIMONIAL", "DOUBLE_INDIVIDUAL", "TRIPLE", "QUADRUPLE"];
      const atLimit = createLodgingRoomsBodySchema.safeParse({
        hotelName: "Hotel",
        rooms: rooms.map((roomType) => ({ roomType, quantity: 40 })),
      });
      assert.equal(atLimit.success, true);
      const overLimit = createLodgingRoomsBodySchema.safeParse({
        hotelName: "Hotel",
        rooms: rooms.map((roomType) => ({ roomType, quantity: 50 })),
      });
      assert.equal(overLimit.success, false);
    });

    it("tour ajeno → 404 sin escribir", async () => {
      const fake = createFakeLodgingDb({ tours: [tour(TOUR_ID)] });
      const res = await postRooms(
        { hotelName: "Hotel", rooms: [{ roomType: "TRIPLE", quantity: 1 }] },
        AGENCY_B,
      );
      assert.equal(res.statusCode, 404);
      assert.equal(writesOf(fake).length, 0);
    });

    it("Modo Solo Lectura → 402 sin llegar al servicio", async () => {
      const readOnlyApp = await createTestApp({ isAgencyReadOnly: async () => true });
      try {
        const fake = createFakeLodgingDb(baseTables());
        for (const [method, url, payload] of [
          [
            "POST",
            `/api/lodging/${TOUR_ID}/rooms`,
            { hotelName: "H", rooms: [{ roomType: "TRIPLE", quantity: 1 }] },
          ],
          ["PATCH", roomUrl(ROOM_MAT), { status: "CONFIRMED" }],
          [
            "POST",
            `${roomUrl(ROOM_MAT)}/assignments`,
            { assignments: [{ slotIndex: 1, bookingPassengerId: P_SOLO }] },
          ],
          ["DELETE", `${roomUrl(ROOM_MAT)}/slots/1`, undefined],
          ["DELETE", roomUrl(ROOM_MAT), undefined],
          ["DELETE", `${roomUrl(ROOM_MAT)}/beds/1`, undefined],
        ] as const) {
          const res = await readOnlyApp.inject({
            method,
            url,
            cookies: sessionCookie(readOnlyApp, AGENCY_A, USER_A),
            ...(payload ? { payload } : {}),
          });
          assert.equal(res.statusCode, 402, `${method} ${url}`);
          assert.equal(res.json().code, "SUBSCRIPTION_READ_ONLY");
        }
        assert.equal(fake.transaction.mock.callCount(), 0);
      } finally {
        await readOnlyApp.close();
      }
    });
  });

  describe("PATCH /lodging/:tourId/rooms/:roomId", () => {
    it("guarda el número de cuarto recortado y lo devuelve con sus camas", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [assignment(ROOM_DOUBLE, HOTEL_1, 1, P_SOLO)],
        }),
      );
      const res = await patchRoom(ROOM_DOUBLE, { roomNumber: "  204 " });
      assert.equal(res.statusCode, 200);
      const { room: updated } = res.json().data;
      assert.equal(updated.roomNumber, "204");
      assert.equal(updated.status, "CONSULTED");
      assert.deepEqual(updated.slots, [{ slotIndex: 1, bookingPassengerId: P_SOLO }]);
      const stored = fake.tables.tour_hotel_rooms.find((r) => r.id === ROOM_DOUBLE)!;
      assert.equal(stored.roomNumber, "204");
      assert.equal(typeof stored.updatedAt, "string");
    });

    it('"" quita el número (null)', async () => {
      const fake = createFakeLodgingDb(baseTables());
      const res = await patchRoom(ROOM_MAT, { roomNumber: "   " });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.room.roomNumber, null);
      assert.equal(fake.tables.tour_hotel_rooms.find((r) => r.id === ROOM_MAT)!.roomNumber, null);
    });

    it("número repetido en el mismo hotel → 409; el mismo número en otro hotel o en la misma habitación sí", async () => {
      const fake = createFakeLodgingDb(baseTables());
      const duplicate = await patchRoom(ROOM_DOUBLE, { roomNumber: "101" });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error, "Ese número de cuarto ya está en uso en este hotel");
      assert.equal(writesOf(fake).length, 0);

      assert.equal((await patchRoom(ROOM_TRIPLE_H2, { roomNumber: "101" })).statusCode, 200);
      assert.equal((await patchRoom(ROOM_MAT, { roomNumber: "101" })).statusCode, 200);
    });

    it("cambia el estado a CONFIRMED", async () => {
      createFakeLodgingDb(baseTables());
      const res = await patchRoom(ROOM_MAT, { status: "CONFIRMED" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.room.status, "CONFIRMED");
      assert.equal(res.json().data.room.roomNumber, "101");
    });

    it("400: body vacío, número de más de 10, estado inválido", async () => {
      const fake = createFakeLodgingDb(baseTables());
      for (const body of [{}, { roomNumber: "12345678901" }, { status: "BOOKED" }]) {
        const res = await patchRoom(ROOM_MAT, body);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
      }
      assert.equal(fake.transaction.mock.callCount(), 0);
    });

    it("habitación de otro tour o de otra agencia → 404", async () => {
      createFakeLodgingDb(baseTables());
      assert.equal((await patchRoom(ROOM_OTHER_TOUR, { status: "CONFIRMED" })).statusCode, 404);
      assert.equal(
        (await patchRoom(ROOM_MAT, { status: "CONFIRMED" }, AGENCY_A, OTHER_TOUR_ID)).statusCode,
        404,
      );
      assert.equal((await patchRoom(ROOM_MAT, { status: "CONFIRMED" }, AGENCY_B)).statusCode, 404);
    });
  });

  describe("POST /lodging/:tourId/rooms/:roomId/assignments", () => {
    it("asigna a un pasajero y guarda quién asignó", async () => {
      const fake = createFakeLodgingDb(baseTables());
      const res = await assign(ROOM_DOUBLE, [{ slotIndex: 2, bookingPassengerId: P_SOLO }]);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json().data.room.slots, [{ slotIndex: 2, bookingPassengerId: P_SOLO }]);
      const [stored] = fake.tables.tour_hotel_room_assignments;
      assert.equal(stored!.assignedByUserId, USER_A);
      assert.equal(stored!.hotelId, HOTEL_1);
      assert.equal(stored!.tourId, TOUR_ID);
      assert.equal(stored!.agencyId, AGENCY_A);
    });

    it("asigna una pareja en un solo envío", async () => {
      createFakeLodgingDb(baseTables());
      const res = await assign(ROOM_MAT, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
        { slotIndex: 2, bookingPassengerId: P_COMPANION },
      ]);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json().data.room.slots, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
        { slotIndex: 2, bookingPassengerId: P_COMPANION },
      ]);
    });

    it("400: cama mayor a la capacidad (sin escribir) y body inválido", async () => {
      const fake = createFakeLodgingDb(baseTables());
      const res = await assign(ROOM_MAT, [{ slotIndex: 3, bookingPassengerId: P_SOLO }]);
      assert.equal(res.statusCode, 400);
      assert.equal(writesOf(fake).length, 0);

      for (const assignments of [
        [],
        [{ slotIndex: 0, bookingPassengerId: P_SOLO }],
        [
          { slotIndex: 1, bookingPassengerId: P_SOLO },
          { slotIndex: 1, bookingPassengerId: P_TITULAR },
        ],
        [
          { slotIndex: 1, bookingPassengerId: P_SOLO },
          { slotIndex: 2, bookingPassengerId: P_SOLO },
        ],
        [1, 2, 3, 4, 5].map((n) => ({ slotIndex: n, bookingPassengerId: uuid("d", 10 + n) })),
      ]) {
        const invalid = await assign(ROOM_TRIPLE_H2, assignments);
        assert.equal(invalid.statusCode, 400, JSON.stringify(assignments));
      }
    });

    it("404: pasajero dado de baja, de reserva cancelada o borrada, de otro tour o inexistente", async () => {
      for (const bookingPassengerId of [
        P_DROPPED,
        P_CANCELLED_BOOKING,
        P_DELETED_BOOKING,
        P_OTHER_TOUR,
        uuid("d", 99),
      ]) {
        const fake = createFakeLodgingDb(baseTables());
        const res = await assign(ROOM_MAT, [{ slotIndex: 1, bookingPassengerId }]);
        assert.equal(res.statusCode, 404, bookingPassengerId);
        assert.equal(res.json().error, "Pasajero no encontrado");
        assert.equal(writesOf(fake).length, 0);
        mock.restoreAll();
      }
    });

    it("409: la cama ya está ocupada por un pasajero vigente (todo o nada)", async () => {
      const fake = createFakeLodgingDb(
        baseTables({ tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 2, P_SOLO)] }),
      );
      const res = await assign(ROOM_MAT, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
        { slotIndex: 2, bookingPassengerId: P_COMPANION },
      ]);
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "Esa cama ya está ocupada");
      assert.equal(writesOf(fake).length, 0);
      assert.equal(fake.tables.tour_hotel_room_assignments.length, 1);
    });

    it("409: el pasajero ya tiene cama en este hotel; en otro hotel del tour sí se permite", async () => {
      const fake = createFakeLodgingDb(
        baseTables({ tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 1, P_SOLO)] }),
      );
      const sameHotel = await assign(ROOM_DOUBLE, [{ slotIndex: 1, bookingPassengerId: P_SOLO }]);
      assert.equal(sameHotel.statusCode, 409);
      assert.equal(sameHotel.json().error, "Ese pasajero ya tiene cama en este hotel");
      assert.equal(writesOf(fake).length, 0);

      const otherHotel = await assign(ROOM_TRIPLE_H2, [
        { slotIndex: 1, bookingPassengerId: P_SOLO },
      ]);
      assert.equal(otherHotel.statusCode, 201);
      assert.equal(fake.tables.tour_hotel_room_assignments.length, 2);
    });

    it("reemplaza asignaciones NO vigentes que estorban (misma cama)", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 1, P_DROPPED)],
        }),
      );
      const res = await assign(ROOM_MAT, [{ slotIndex: 1, bookingPassengerId: P_TITULAR }]);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json().data.room.slots, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
      ]);
      assert.deepEqual(
        fake.tables.tour_hotel_room_assignments.map((row) => row.bookingPassengerId),
        [P_TITULAR],
      );
    });

    it("habitación de otro tour o de otra agencia → 404 sin escribir", async () => {
      const fake = createFakeLodgingDb(baseTables());
      const payload = [{ slotIndex: 1, bookingPassengerId: P_SOLO }];
      assert.equal((await assign(ROOM_OTHER_TOUR, payload)).statusCode, 404);
      assert.equal((await assign(ROOM_MAT, payload, AGENCY_B)).statusCode, 404);
      assert.equal(writesOf(fake).length, 0);
    });
  });

  describe("DELETE /lodging/:tourId/rooms/:roomId/slots/:slotIndex", () => {
    it("libera la cama y devuelve la habitación", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [
            assignment(ROOM_MAT, HOTEL_1, 1, P_TITULAR),
            assignment(ROOM_MAT, HOTEL_1, 2, P_COMPANION),
          ],
        }),
      );
      const res = await unassign(ROOM_MAT, 1);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data.room.slots, [
        { slotIndex: 2, bookingPassengerId: P_COMPANION },
      ]);
      assert.equal(fake.tables.tour_hotel_room_assignments.length, 1);
    });

    it("cama vacía → 404; slotIndex inválido → 400; habitación ajena → 404", async () => {
      createFakeLodgingDb(
        baseTables({ tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 1, P_TITULAR)] }),
      );
      assert.equal((await unassign(ROOM_MAT, 2)).statusCode, 404);
      assert.equal((await unassign(ROOM_MAT, "cero")).statusCode, 400);
      assert.equal((await unassign(ROOM_MAT, 0)).statusCode, 400);
      assert.equal((await unassign(ROOM_OTHER_TOUR, 1)).statusCode, 404);
      assert.equal((await unassign(ROOM_MAT, 1, AGENCY_B)).statusCode, 404);
    });
  });

  describe("DELETE /lodging/:tourId/rooms/:roomId", () => {
    it("habitación libre: la borra, conserva el hotel y no renumera las demás", async () => {
      const fake = createFakeLodgingDb(baseTables());
      const res = await deleteRoom(ROOM_DOUBLE);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { data: { deletedRoomId: ROOM_DOUBLE, releasedPassengers: 0 } });

      const lodging = (await getLodging()).json().data;
      const hotel = lodging.hotels.find((h: Row) => h.id === HOTEL_1);
      assert.deepEqual(
        hotel.rooms.map((r: Row) => [r.id, r.position]),
        [
          [ROOM_MAT, 1],
          [ROOM_MAT_2, 3],
        ],
      );
      assert.equal(fake.tables.tour_hotels.length, 3);
    });

    it("con pasajeros: cuenta solo las asignaciones vigentes y los deja sin cama", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 1, P_TITULAR),
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 2, P_DROPPED), // no vigente
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 3, P_COMPANION),
            assignment(ROOM_MAT, HOTEL_1, 1, P_SOLO),
          ],
        }),
      );
      const res = await deleteRoom(ROOM_TRIPLE_H2);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, { deletedRoomId: ROOM_TRIPLE_H2, releasedPassengers: 2 });

      // Cascade: se borran sus camas; las de otras habitaciones siguen.
      assert.deepEqual(
        fake.tables.tour_hotel_room_assignments.map((row) => row.bookingPassengerId),
        [P_SOLO],
      );
      const lodging = (await getLodging()).json().data;
      const hotel2 = lodging.hotels.find((h: Row) => h.id === HOTEL_2);
      assert.deepEqual(hotel2.rooms, []); // el hotel se conserva sin habitaciones
      const housed = lodging.hotels.flatMap((h: { rooms: { slots: LodgingSlotRow[] }[] }) =>
        h.rooms.flatMap((r) => r.slots.map((slot) => slot.bookingPassengerId)),
      );
      assert.deepEqual(housed, [P_SOLO]);
      assert.equal(lodging.totalCapacity, 2 + 2 + 2);
    });

    it("la siguiente habitación nueva sigue desde la mayor posición", async () => {
      const fake = createFakeLodgingDb(baseTables());
      assert.equal((await deleteRoom(ROOM_DOUBLE)).statusCode, 200);
      const res = await postRooms({
        hotelName: "Hotel Real",
        rooms: [{ roomType: "TRIPLE", quantity: 1 }],
      });
      assert.equal(res.statusCode, 201);
      const created = fake.tables.tour_hotel_rooms.find(
        (r) => r.hotelId === HOTEL_1 && r.roomType === "TRIPLE",
      );
      assert.equal(created!.position, 4);
    });

    it("habitación de otro tour, de otra agencia o inexistente → 404 sin escribir; id inválido → 400", async () => {
      const fake = createFakeLodgingDb(baseTables());
      assert.equal((await deleteRoom(ROOM_OTHER_TOUR)).statusCode, 404);
      assert.equal((await deleteRoom(ROOM_MAT, AGENCY_A, OTHER_TOUR_ID)).statusCode, 404);
      assert.equal((await deleteRoom(ROOM_MAT, AGENCY_B)).statusCode, 404);
      assert.equal((await deleteRoom(uuid("c", 99))).statusCode, 404);
      assert.equal((await deleteRoom("no-es-uuid")).statusCode, 400);
      assert.equal(writesOf(fake).length, 0);
      assert.equal(fake.tables.tour_hotel_rooms.length, 5);
    });
  });

  describe("DELETE /lodging/:tourId/rooms/:roomId/beds/:slotIndex", () => {
    const QUAD = uuid("c", 6);
    const quadTables = (assignments: Row[]) =>
      baseTables({
        tour_hotel_rooms: [
          ...(baseTables().tour_hotel_rooms ?? []),
          room(QUAD, HOTEL_2, { roomType: "QUADRUPLE", capacity: 4, position: 2 }),
        ],
        tour_hotel_room_assignments: assignments,
      });

    it("cama libre del medio: recorre las siguientes conservando a sus pasajeros", async () => {
      const fake = createFakeLodgingDb(
        quadTables([
          assignment(QUAD, HOTEL_2, 1, P_TITULAR),
          assignment(QUAD, HOTEL_2, 3, P_COMPANION),
          assignment(QUAD, HOTEL_2, 4, P_SOLO),
        ]),
      );
      const res = await deleteBed(QUAD, 2);
      assert.equal(res.statusCode, 200);
      const { room: updated, releasedPassenger } = res.json().data;
      assert.equal(releasedPassenger, false);
      assert.equal(updated.capacity, 3);
      assert.equal(updated.roomType, "TRIPLE"); // Cuádruple con 3 lugares → Triple
      assert.deepEqual(updated.slots, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
        { slotIndex: 2, bookingPassengerId: P_COMPANION },
        { slotIndex: 3, bookingPassengerId: P_SOLO },
      ]);
      const stored = fake.tables.tour_hotel_rooms.find((r) => r.id === QUAD)!;
      assert.equal(stored.capacity, 3);
      assert.equal(stored.roomType, "TRIPLE");
      assert.equal(typeof stored.updatedAt, "string");
    });

    it("cama ocupada: libera al pasajero (releasedPassenger) y recorre la siguiente", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 1, P_TITULAR),
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 2, P_COMPANION),
          ],
        }),
      );
      const res = await deleteBed(ROOM_TRIPLE_H2, 1);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.releasedPassenger, true);
      assert.equal(res.json().data.room.capacity, 2);
      assert.deepEqual(res.json().data.room.slots, [
        { slotIndex: 1, bookingPassengerId: P_COMPANION },
      ]);
      const lodging = (await getLodging()).json().data;
      assert.equal(lodging.totalCapacity, 2 + 2 + 2 + 2);
      assert.equal(fake.tables.tour_hotel_room_assignments.length, 1);
    });

    it("cama con una asignación NO vigente: la borra y releasedPassenger es false", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [assignment(ROOM_TRIPLE_H2, HOTEL_2, 2, P_DROPPED)],
        }),
      );
      const res = await deleteBed(ROOM_TRIPLE_H2, 2);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.releasedPassenger, false);
      assert.equal(fake.tables.tour_hotel_room_assignments.length, 0);
    });

    it("última cama: baja la capacidad sin recorrer a nadie", async () => {
      createFakeLodgingDb(
        baseTables({
          tour_hotel_room_assignments: [
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 1, P_TITULAR),
            assignment(ROOM_TRIPLE_H2, HOTEL_2, 3, P_SOLO),
          ],
        }),
      );
      const res = await deleteBed(ROOM_TRIPLE_H2, 3);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.releasedPassenger, true);
      assert.equal(res.json().data.room.capacity, 2);
      assert.deepEqual(res.json().data.room.slots, [
        { slotIndex: 1, bookingPassengerId: P_TITULAR },
      ]);
    });

    it("habitación de un solo lugar → 409 sin escribir", async () => {
      const fake = createFakeLodgingDb(
        baseTables({
          tour_hotel_rooms: [room(ROOM_MAT, HOTEL_1, { capacity: 1 })],
        }),
      );
      const res = await deleteBed(ROOM_MAT, 1);
      assert.equal(res.statusCode, 409);
      assert.equal(
        res.json().error,
        "La habitación solo tiene un lugar: elimina la habitación completa.",
      );
      assert.equal(writesOf(fake).length, 0);
    });

    it("slotIndex inválido → 400; mayor a la capacidad → 404; habitación ajena → 404", async () => {
      const fake = createFakeLodgingDb(baseTables());
      for (const slot of [0, -1, "1.5", "cero"]) {
        assert.equal((await deleteBed(ROOM_MAT, slot)).statusCode, 400, String(slot));
      }
      const outOfRange = await deleteBed(ROOM_MAT, 3);
      assert.equal(outOfRange.statusCode, 404);
      assert.equal(outOfRange.json().error, "Cama no encontrada");
      assert.equal((await deleteBed(ROOM_OTHER_TOUR, 1)).statusCode, 404);
      assert.equal((await deleteBed(ROOM_MAT, 1, AGENCY_A, OTHER_TOUR_ID)).statusCode, 404);
      assert.equal((await deleteBed(ROOM_MAT, 1, AGENCY_B)).statusCode, 404);
      assert.equal(writesOf(fake).length, 0);
    });

    it("cambia el tipo según la nueva capacidad y el GET posterior lo refleja", async () => {
      const fake = createFakeLodgingDb(quadTables([]));
      const cases: [string, number, string, number][] = [
        [ROOM_MAT, 1, "SINGLE", 1], // Matrimonial 2 → 1
        [ROOM_DOUBLE, 2, "SINGLE", 1], // Doble Individual 2 → 1
        [ROOM_TRIPLE_H2, 3, "DOUBLE_INDIVIDUAL", 2], // Triple 3 → 2 (no se asume pareja)
        [QUAD, 4, "TRIPLE", 3], // Cuádruple 4 → 3
        [QUAD, 3, "DOUBLE_INDIVIDUAL", 2], // y luego 3 → 2
      ];
      for (const [roomId, slot, roomType, capacity] of cases) {
        const res = await deleteBed(roomId, slot);
        assert.equal(res.statusCode, 200, `${roomId} cama ${slot}`);
        assert.equal(res.json().data.room.roomType, roomType);
        assert.equal(res.json().data.room.capacity, capacity);
        const stored = fake.tables.tour_hotel_rooms.find((r) => r.id === roomId)!;
        assert.equal(stored.roomType, roomType);
      }

      const rooms = new Map<string, Row>(
        (await getLodging())
          .json()
          .data.hotels.flatMap((hotel: { rooms: Row[] }) => hotel.rooms)
          .map((r: Row) => [r.id, r]),
      );
      assert.deepEqual(
        [ROOM_MAT, ROOM_DOUBLE, ROOM_TRIPLE_H2, QUAD, ROOM_MAT_2].map((id) => [
          rooms.get(id)?.roomType,
          rooms.get(id)?.capacity,
        ]),
        [
          ["SINGLE", 1],
          ["SINGLE", 1],
          ["DOUBLE_INDIVIDUAL", 2],
          ["DOUBLE_INDIVIDUAL", 2],
          ["MATRIMONIAL", 2], // sin cambios
        ],
      );
    });

    it("asignar después respeta la nueva capacidad", async () => {
      createFakeLodgingDb(baseTables());
      assert.equal((await deleteBed(ROOM_TRIPLE_H2, 2)).statusCode, 200);
      const beyond = await assign(ROOM_TRIPLE_H2, [{ slotIndex: 3, bookingPassengerId: P_SOLO }]);
      assert.equal(beyond.statusCode, 400);
      const inside = await assign(ROOM_TRIPLE_H2, [{ slotIndex: 2, bookingPassengerId: P_SOLO }]);
      assert.equal(inside.statusCode, 201);
    });
  });

  it("Modo Auditoría (FINALIZADO o CANCELADO) → 409 sin escribir en ninguna mutación", async () => {
    for (const overrides of [
      { departureDateTime: "2020-01-01", returnDate: null },
      { cancelledAt: "2026-11-20T10:00:00.000Z" },
    ]) {
      const tables = baseTables({
        tours: [tour(TOUR_ID, overrides)],
        tour_hotel_room_assignments: [assignment(ROOM_MAT, HOTEL_1, 1, P_TITULAR)],
      });
      const fake = createFakeLodgingDb(tables);
      const responses = [
        await postRooms({ hotelName: "Hotel", rooms: [{ roomType: "TRIPLE", quantity: 1 }] }),
        await patchRoom(ROOM_MAT, { roomNumber: "300", status: "CONFIRMED" }),
        await assign(ROOM_DOUBLE, [{ slotIndex: 1, bookingPassengerId: P_SOLO }]),
        await unassign(ROOM_MAT, 1),
        await deleteRoom(ROOM_MAT),
        await deleteBed(ROOM_TRIPLE_H2, 1),
      ];
      for (const res of responses) assert.equal(res.statusCode, 409);
      assert.equal(writesOf(fake).length, 0);
      mock.restoreAll();
    }
  });
});
