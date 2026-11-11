import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  USER_B,
  chain,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

const TOUR_A = "77777777-7777-4777-8777-777777777777";
const TOUR_B = "88888888-8888-4888-8888-888888888888";
const BOOKING_A = "99999999-9999-4999-8999-999999999999";
const PASSENGER_A = "aaaaaaaa-0000-4000-8000-000000000001"; // traveler.id de un pasajero del tour A
const PASSENGER_B = "bbbbbbbb-0000-4000-8000-000000000002"; // traveler.id de otra agencia

const toursTable = [
  { id: TOUR_A, agencyId: AGENCY_A, deletedAt: null },
  { id: TOUR_B, agencyId: AGENCY_B, deletedAt: null },
];

const toursFindFirst = async ({ where }: { where?: SQL }) =>
  toursTable.find((t) => rowMatches(where, t));

const seatsUrl = (tourId: string, seat?: string) =>
  `/api/seats/${tourId}/seats${seat ? `/${seat}` : ""}`;

/**
 * Transacción simulada de updateSeatStatus. `assignedRows` es lo que devuelve el UPDATE de
 * asignación (filas de booking_passengers del tour que coinciden con passengerId).
 */
function mockSeatTransaction(assignedRows: { id: string }[]) {
  const select = mock.fn(() => chain([{ id: BOOKING_A }]));
  const update = mock.fn(() => chain(assignedRows));
  const del = mock.fn(() => chain(undefined));
  const insert = mock.fn(() => chain(undefined));
  const tx = {
    query: { tours: { findFirst: toursFindFirst } },
    select,
    update,
    delete: del,
    insert,
  };
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return { select, update, del, insert };
}

describe("/api/seats: autenticación y aislamiento por agencia", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  describe("GET /:tourId/seats", () => {
    it("sin autenticación: 401 y no consulta la base", async () => {
      const findFirst = mock.method(db.query.tours, "findFirst", toursFindFirst as never);
      const select = mock.method(db, "select", (() => chain([])) as never);

      const res = await app.inject({ method: "GET", url: seatsUrl(TOUR_A) });

      assert.equal(res.statusCode, 401);
      assert.equal(findFirst.mock.callCount(), 0);
      assert.equal(select.mock.callCount(), 0);
    });

    it("usuario de A lee el mapa de asientos de su tour", async () => {
      mock.method(db.query.tours, "findFirst", toursFindFirst as never);
      const results = [
        [{ seatLabel: "01", passengerId: PASSENGER_A, fullName: "Pasajero A" }],
        [{ seatLabel: "02", reason: "STAFF" }],
      ];
      mock.method(db, "select", (() => chain(results.shift())) as never);

      const res = await app.inject({
        method: "GET",
        url: seatsUrl(TOUR_A),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, [
        {
          seatLabel: "01",
          status: "ASSIGNED",
          passenger: { id: PASSENGER_A, fullName: "Pasajero A" },
        },
        { seatLabel: "02", status: "BLOCKED", passenger: null },
      ]);
    });

    it("usuario de A no puede leer los asientos de un tour de B (404, sin leer pasajeros)", async () => {
      mock.method(db.query.tours, "findFirst", toursFindFirst as never);
      const select = mock.method(db, "select", (() => chain([])) as never);

      const res = await app.inject({
        method: "GET",
        url: seatsUrl(TOUR_B),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });

      assert.equal(res.statusCode, 404);
      assert.equal(select.mock.callCount(), 0);
    });
  });

  describe("PATCH /:tourId/seats/:seatLabel", () => {
    it("sin autenticación: 401 y no abre transacción", async () => {
      const transaction = mock.method(db, "transaction", (async () => undefined) as never);

      const res = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "01"),
        payload: { status: "BLOCKED" },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(transaction.mock.callCount(), 0);
    });

    it("usuario de B no puede modificar asientos del tour de A (404, sin escrituras)", async () => {
      const { select, update, del, insert } = mockSeatTransaction([{ id: "row" }]);

      const res = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "01"),
        cookies: sessionCookie(app, AGENCY_B, USER_B),
        payload: { status: "ASSIGNED", passengerId: PASSENGER_A },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(select.mock.callCount() + update.mock.callCount(), 0);
      assert.equal(del.mock.callCount() + insert.mock.callCount(), 0);
    });

    it("usuario de A asigna un asiento a un pasajero de su tour", async () => {
      const { update } = mockSeatTransaction([{ id: "row" }]);

      const res = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "01"),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { status: "ASSIGNED", passengerId: PASSENGER_A },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, { success: true, seatLabel: "01", status: "ASSIGNED" });
      assert.equal(update.mock.callCount(), 2); // liberar etiqueta + asignar
    });

    it("manipular passengerId con un viajero ajeno al tour: 404 (la transacción se revierte)", async () => {
      mockSeatTransaction([]); // el UPDATE de asignación no encuentra filas del tour

      const res = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "01"),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { status: "ASSIGNED", passengerId: PASSENGER_B },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, "Pasajero no encontrado en este tour");
    });

    it("usuario de A bloquea y libera asientos de su tour", async () => {
      const { insert } = mockSeatTransaction([]);

      const blocked = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "03"),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { status: "BLOCKED" },
      });
      const released = await app.inject({
        method: "PATCH",
        url: seatsUrl(TOUR_A, "03"),
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { status: "AVAILABLE", passengerId: null },
      });

      assert.equal(blocked.statusCode, 200);
      assert.equal(released.statusCode, 200);
      assert.equal(insert.mock.callCount(), 1); // solo el bloqueo inserta
    });
  });
});
