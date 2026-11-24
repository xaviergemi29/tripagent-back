import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../src/db/index.js";
import {
  STAFF_SHARE_TOKEN_LENGTH,
  buildBoardingKey,
} from "../src/shared/utils/staff-share.util.js";
import {
  AGENCY_A,
  USER_A,
  chain,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

/**
 * Pase de lista de abordaje (RB-MAN-002, 2026-11-23): el operador (con sesión) y el coordinador
 * (enlace de staff) marcan en vivo quién ya subió al transporte.
 */

const TOUR_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const TRAVELER_ID = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const TOKEN = "A".repeat(STAFF_SHARE_TOKEN_LENGTH);
const OTHER_TOKEN = "B".repeat(STAFF_SHARE_TOKEN_LENGTH);
const dialect = new PgDialect();

const tourRow = (overrides: Record<string, unknown> = {}) => ({
  id: TOUR_ID,
  agencyId: AGENCY_A,
  deletedAt: null,
  cancelledAt: null,
  staffShareToken: TOKEN,
  title: "Huasteca Potosina",
  price: 1000,
  depositPerPerson: 500,
  departureDateTime: "2099-03-10",
  returnDate: "2099-03-12",
  boardingPoints: [{ id: "bp-1", location: "Plaza Xalapa", time: "06:00" }],
  agency: {
    name: "Viajes Xalapa",
    logoPath: null,
    isActive: true,
    deletedAt: null,
    subscriptionStatus: "active",
    trialEndsAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    subscriptionPeriodEndsAt: null,
  },
  vehicle: null,
  ...overrides,
});

const bookingRows = () => [
  {
    totalPrice: 2000,
    amountPaid: 1000,
    magicToken: { numberPassengers: 2 },
    traveler: { fullName: "Mariana Ruiz" },
    passengers: [
      {
        id: "bp-row-mariana",
        travelerId: TRAVELER_ID,
        isTitular: true,
        seatLabel: "4",
        boardingPoint: "bp-1",
        passengerType: "ADULT",
        boardedAt: null,
        traveler: { fullName: "Mariana Ruiz" },
      },
      {
        id: "bp-row-diego",
        travelerId: "trav-diego",
        isTitular: false,
        seatLabel: null,
        boardingPoint: null,
        passengerType: "CHILD",
        boardedAt: "2099-03-10T12:00:00.000Z",
        traveler: { fullName: "Diego Ruiz" },
      },
    ],
  },
];

/** Tour (evaluando el WHERE real), reservas y habitaciones (una asignada a Mariana). */
function mockReads(tour: Record<string, unknown> | null = tourRow()) {
  mock.method(db.query.tours, "findFirst", (async (args: { where: SQL }) =>
    tour && rowMatches(args.where, tour) ? tour : undefined) as never);
  mock.method(db.query.bookings, "findMany", (async () => bookingRows()) as never);
  let selectCalls = 0;
  mock.method(db, "select", (() => {
    selectCalls += 1;
    // 1.ª: habitaciones del tour; 2.ª: asignaciones de los pasajeros.
    if (selectCalls === 1) {
      return chain([
        {
          roomId: "r1",
          hotelId: "h1",
          hotelName: "Hotel Sierra",
          roomNumber: null,
          roomType: "MATRIMONIAL",
        },
        {
          roomId: "r2",
          hotelId: "h1",
          hotelName: "Hotel Sierra",
          roomNumber: "102",
          roomType: "MATRIMONIAL",
        },
      ]);
    }
    return chain([{ roomId: "r2", bookingPassengerId: "bp-row-mariana" }]);
  }) as never);
}

/** UPDATE falso: guarda el SET y el WHERE, y devuelve `returned`. */
function mockUpdate(returned: Record<string, unknown>[]) {
  const calls: { values: Record<string, unknown>; where: SQL }[] = [];
  mock.method(db, "update", (() => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: SQL) => {
        calls.push({ values, where });
        return { returning: async () => returned };
      },
    }),
  })) as never);
  return calls;
}

describe("Pase de lista: Centro de Control (con sesión)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);
  const patch = (boarded: unknown, travelerId = TRAVELER_ID) =>
    app.inject({
      method: "PATCH",
      url: `/api/tours/${TOUR_ID}/passengers/${travelerId}/boarding`,
      cookies: cookies(),
      payload: { boarded },
    });

  it("401 sin sesión", async () => {
    const res = await app.inject({ method: "GET", url: `/api/tours/${TOUR_ID}/boarding` });
    assert.equal(res.statusCode, 401);
  });

  it("GET: lista con titular, punto de abordaje, asiento, habitación y abordaje", async () => {
    mockReads();
    const res = await app.inject({
      method: "GET",
      url: `/api/tours/${TOUR_ID}/boarding`,
      cookies: cookies(),
    });
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.equal(data.canMarkBoarding, true);
    assert.equal(data.temporalStatus, "PRÓXIMO");
    assert.deepEqual(data.passengers[0], {
      travelerId: TRAVELER_ID,
      fullName: "Mariana Ruiz",
      holderName: "Mariana Ruiz",
      isTitular: true,
      passengerType: "ADULT",
      seatLabel: "4",
      boardingPointCode: "P1",
      rooms: [
        { hotelName: "Hotel Sierra", roomNumber: "102", roomType: "MATRIMONIAL", typeIndex: 2 },
      ],
      boardedAt: null,
    });
    assert.equal(data.passengers[1].holderName, "Mariana Ruiz");
    assert.equal(data.passengers[1].boardedAt, "2099-03-10T12:00:00.000Z");
  });

  it("GET de un tour ajeno → 404", async () => {
    mockReads(tourRow({ agencyId: "otra-agencia" }));
    const res = await app.inject({
      method: "GET",
      url: `/api/tours/${TOUR_ID}/boarding`,
      cookies: cookies(),
    });
    assert.equal(res.statusCode, 404);
  });

  it("marca el abordaje con la hora y el operador; el WHERE exige tour, agencia y pasajero ACTIVE", async () => {
    mockReads();
    const calls = mockUpdate([
      {
        bookingPassengerId: "bp-row-mariana",
        travelerId: TRAVELER_ID,
        boardedAt: "2099-03-10T12:30:00.000Z",
      },
    ]);
    const res = await patch(true);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, {
      travelerId: TRAVELER_ID,
      boardedAt: "2099-03-10T12:30:00.000Z",
    });
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0]!.values.boardedAt, "string");
    assert.equal(calls[0]!.values.boardedByUserId, USER_A);

    // Aislamiento (IDOR): el UPDATE filtra por el viajero, su estado y las reservas del tour de la
    // agencia de la sesión (no canceladas ni borradas).
    const { sql, params } = dialect.sqlToQuery(calls[0]!.where);
    assert.match(sql, /"traveler_id" = \$\d/);
    assert.match(sql, /"status" = \$\d/);
    assert.match(sql, /"booking_id" in \(select/);
    assert.match(sql, /"deleted_at" is null/);
    for (const value of [TRAVELER_ID, "ACTIVE", TOUR_ID, AGENCY_A, "CANCELLED"]) {
      assert.ok(params.includes(value), `el WHERE debe incluir ${value}`);
    }
  });

  it("desmarcar limpia la hora y el operador", async () => {
    mockReads();
    const calls = mockUpdate([
      { bookingPassengerId: "bp-row-mariana", travelerId: TRAVELER_ID, boardedAt: null },
    ]);
    const res = await patch(false);
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0]!.values.boardedAt, null);
    assert.equal(calls[0]!.values.boardedByUserId, null);
  });

  it("un pasajero de otro tour, dado de baja o de una reserva cancelada → 404 (el UPDATE no encuentra fila)", async () => {
    mockReads();
    mockUpdate([]);
    const res = await patch(true, "99999999-9999-4999-8999-999999999999");
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /Pasajero no encontrado/);
  });

  it("409 en un tour FINALIZADO o CANCELADO, sin escribir", async () => {
    for (const overrides of [
      { departureDateTime: "2020-01-10", returnDate: "2020-01-12" },
      { cancelledAt: "2099-01-01T00:00:00Z" },
    ]) {
      mockReads(tourRow(overrides));
      const calls = mockUpdate([]);
      const res = await patch(true);
      assert.equal(res.statusCode, 409);
      assert.equal(calls.length, 0);
      mock.restoreAll();
    }
  });

  it("400 sin `boarded` booleano", async () => {
    const res = await patch("sí");
    assert.equal(res.statusCode, 400);
  });

  it("402 con la agencia en Modo Solo Lectura", async () => {
    const readOnlyApp = await createTestApp({ isAgencyReadOnly: async () => true });
    const res = await readOnlyApp.inject({
      method: "PATCH",
      url: `/api/tours/${TOUR_ID}/passengers/${TRAVELER_ID}/boarding`,
      cookies: sessionCookie(readOnlyApp, AGENCY_A, USER_A),
      payload: { boarded: true },
    });
    assert.equal(res.statusCode, 402);
    await readOnlyApp.close();
  });
});

describe("Pase de lista: enlace de staff (sin sesión)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const keyOf = (bookingPassengerId: string, token = TOKEN) =>
    buildBoardingKey(token, bookingPassengerId);
  const patch = (key: string, boarded = true, token = TOKEN) =>
    app.inject({
      method: "PATCH",
      url: `/api/public/staff-share/${token}/boarding/${key}`,
      payload: { boarded },
    });

  it("la clave es opaca, estable por enlace y distinta entre enlaces", () => {
    const key = keyOf("bp-row-mariana");
    assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(key, keyOf("bp-row-mariana"));
    assert.notEqual(key, keyOf("bp-row-mariana", OTHER_TOKEN));
    assert.ok(!key.includes("bp-row"));
  });

  it("GET /boarding: lista sin ids internos y con `canMarkBoarding`", async () => {
    mockReads();
    const res = await app.inject({
      method: "GET",
      url: `/api/public/staff-share/${TOKEN}/boarding`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const data = res.json().data;
    assert.equal(data.canMarkBoarding, true);
    assert.equal(data.passengers[0].boardingKey, keyOf("bp-row-mariana"));
    assert.ok(!res.body.includes(TRAVELER_ID));
    assert.ok(!res.body.includes("bp-row-mariana"));
    assert.equal("travelerId" in data.passengers[0], false);
  });

  it("marca con la clave del enlace: escribe la fila de ESE pasajero sin operador", async () => {
    mockReads();
    const calls = mockUpdate([
      {
        bookingPassengerId: "bp-row-mariana",
        travelerId: TRAVELER_ID,
        boardedAt: "2099-03-10T12:30:00.000Z",
      },
    ]);
    const key = keyOf("bp-row-mariana");
    const res = await patch(key);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { boardingKey: key, boardedAt: "2099-03-10T12:30:00.000Z" });
    assert.equal(calls[0]!.values.boardedByUserId, null);
    const { params } = dialect.sqlToQuery(calls[0]!.where);
    assert.ok(params.includes("bp-row-mariana"));
    assert.ok(params.includes(TOUR_ID));
    assert.ok(params.includes(AGENCY_A));
    // La respuesta no expone ids internos.
    assert.ok(!res.body.includes(TRAVELER_ID));
  });

  it("clave de otro enlace, de un pasajero que no está en la lista o mal formada → 404 sin escribir", async () => {
    for (const key of [
      keyOf("bp-row-mariana", OTHER_TOKEN),
      keyOf("bp-row-de-otro-tour"),
      "corta",
    ]) {
      mockReads();
      const calls = mockUpdate([]);
      const res = await patch(key);
      assert.equal(res.statusCode, 404, key);
      assert.equal(calls.length, 0, key);
      mock.restoreAll();
    }
  });

  it("token inexistente, vencido o de una agencia suspendida → 404 con el mismo mensaje", async () => {
    for (const tour of [
      null,
      tourRow({ departureDateTime: "2020-01-10", returnDate: "2020-01-12" }),
      tourRow({ agency: { ...tourRow().agency, isActive: false } }),
    ]) {
      mockReads(tour);
      const calls = mockUpdate([]);
      const res = await patch(keyOf("bp-row-mariana"));
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, "Este enlace no está disponible");
      assert.equal(calls.length, 0);
      mock.restoreAll();
    }
  });

  it("409 con la agencia en Modo Solo Lectura (la consulta sigue abierta)", async () => {
    const readOnlyTour = tourRow({
      agency: { ...tourRow().agency, subscriptionStatus: "past_due" },
    });
    mockReads(readOnlyTour);
    const calls = mockUpdate([]);
    const res = await patch(keyOf("bp-row-mariana"));
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /modo solo lectura/);
    assert.equal(calls.length, 0);

    mock.restoreAll();
    mockReads(readOnlyTour);
    const view = await app.inject({
      method: "GET",
      url: `/api/public/staff-share/${TOKEN}/boarding`,
    });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().data.canMarkBoarding, false);
  });

  it("FINALIZADO dentro de la vigencia del enlace: se consulta, pero no se marca (409)", async () => {
    // Regresó ayer: el enlace vence hoy al final del día; el tour ya está FINALIZADO.
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const finished = tourRow({ departureDateTime: iso(yesterday), returnDate: iso(yesterday) });
    mockReads(finished);
    const view = await app.inject({
      method: "GET",
      url: `/api/public/staff-share/${TOKEN}/boarding`,
    });
    if (view.statusCode === 200) {
      assert.equal(view.json().data.canMarkBoarding, false);
      mockUpdate([]);
      const res = await patch(keyOf("bp-row-mariana"));
      assert.equal(res.statusCode, 409);
    } else {
      // Según la hora de la prueba el enlace ya pudo vencer: entonces responde el 404 único.
      assert.equal(view.statusCode, 404);
    }
  });
});
