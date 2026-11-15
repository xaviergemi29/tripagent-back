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

const TOUR_A = "44444444-4444-4444-8444-444444444444";
const VEHICLE_A = "55555555-5555-4555-8555-555555555555";
const VEHICLE_B = "66666666-6666-4666-8666-666666666666";

const toursTable = [{ id: TOUR_A, agencyId: AGENCY_A, price: 1000, maxCapacity: 20 }];
const vehiclesTable = [
  { id: VEHICLE_A, agencyId: AGENCY_A, layoutMap: [["01", "02"]] },
  { id: VEHICLE_B, agencyId: AGENCY_B, layoutMap: [["01", "02"]] },
];

const findIn =
  <T extends Record<string, unknown>>(table: T[]) =>
  async ({ where }: { where?: SQL }) =>
    table.find((row) => rowMatches(where, row));

/** Marca que la ejecución superó la validación de pertenencia y siguió con la lógica normal. */
const PASSED_OWNERSHIP_CHECK = "PASSED_OWNERSHIP_CHECK";

function mockTransaction(tx: Record<string, unknown>) {
  return mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
}

describe("POST /api/bookings/:id/quick-booking — el tour debe ser de la agencia", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const body = {
    fullName: "Cliente Prueba",
    whatsapp: "5512345678",
    email: "cliente@test.mx",
    numberPassengers: 2,
  };

  it("rechaza (404) un tour de otra agencia sin crear nada", async () => {
    const insert = mock.fn();
    const select = mock.fn(() => {
      throw new Error(PASSED_OWNERSHIP_CHECK);
    });
    mockTransaction({ query: { tours: { findFirst: findIn(toursTable) } }, insert, select });

    const res = await app.inject({
      method: "POST",
      url: `/api/bookings/${TOUR_A}/quick-booking`,
      cookies: sessionCookie(app, AGENCY_B, USER_B),
      payload: body,
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "Tour no encontrado");
    assert.equal(select.mock.callCount(), 0);
    assert.equal(insert.mock.callCount(), 0);
  });

  it("permite continuar cuando el tour es de la agencia de la sesión", async () => {
    const select = mock.fn(() => {
      throw new Error(PASSED_OWNERSHIP_CHECK);
    });
    mockTransaction({ query: { tours: { findFirst: findIn(toursTable) } }, select });

    const res = await app.inject({
      method: "POST",
      url: `/api/bookings/${TOUR_A}/quick-booking`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: body,
    });

    // El flujo pasó la validación y llegó al candado de capacidad (simulado con un corte). El corte
    // es un error inesperado: 500 con mensaje genérico (el texto interno nunca sale al cliente).
    assert.equal(select.mock.callCount(), 1);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "Error interno del servidor" });
  });
});

describe("PATCH /api/tours/:id/vehicle — el vehículo debe ser de la agencia", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  function txWithUpdateSpy() {
    const returning = mock.fn(async () => [
      { id: TOUR_A, agencyId: AGENCY_A, vehicleId: VEHICLE_A },
    ]);
    const update = mock.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
    const tx = {
      query: {
        vehicles: { findFirst: findIn(vehiclesTable) },
        bookings: { findMany: async () => [] }, // sin pasajeros con derecho a asiento
      },
      // SELECT … FOR UPDATE del tour (y subconsulta de reservas al liberar asientos).
      select: () => chain([{ id: TOUR_A, price: 1000, depositPerPerson: 0 }]),
      update,
      delete: () => chain([]),
    };
    return { tx, update };
  }

  it("rechaza (404) un vehículo de otra agencia y no modifica el tour", async () => {
    const { tx, update } = txWithUpdateSpy();
    mockTransaction(tx);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tours/${TOUR_A}/vehicle`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { vehicleId: VEHICLE_B },
    });

    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /Vehículo no encontrado/);
    assert.equal(update.mock.callCount(), 0);
  });

  it("asigna un vehículo propio de la agencia", async () => {
    const { tx, update } = txWithUpdateSpy();
    mockTransaction(tx);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tours/${TOUR_A}/vehicle`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { vehicleId: VEHICLE_A },
    });

    assert.equal(res.statusCode, 200);
    // 1) vehicleId del tour, 2) liberación de asientos que no existen en el nuevo layout.
    assert.equal(update.mock.callCount(), 2);
    assert.equal(res.json().data.vehicleId, VEHICLE_A);
  });
});
