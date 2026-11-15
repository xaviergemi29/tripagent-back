import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { VEHICLE_TEMPLATE_CATALOG } from "../src/db/catalog/vehicle-templates.catalog.js";
import {
  getLayoutSeats,
  getVehicleCapacity,
  layoutMapSchema,
} from "../src/shared/utils/vehicle-layout.util.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Catálogo de plantillas de vehículos (2026-11-12): croquis tipados (SEAT pasajero/staff, DRIVER,
// WC), capacidad sin operador, asignación desde el catálogo y asientos de staff del croquis.

const TOUR_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TEMPLATE_ID = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const VEHICLE_ID = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";

const template = (code: string) => {
  const found = VEHICLE_TEMPLATE_CATALOG.find((t) => t.code === code);
  assert.ok(found, `Falta la plantilla ${code}`);
  return found;
};
const labels = (code: string) => getLayoutSeats(template(code).layoutMap).map((s) => s.label);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

function mockTransaction(tx: Record<string, unknown>) {
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
}

describe("Catálogo de plantillas: croquis de las imágenes", () => {
  it("las tres plantillas son croquis válidos (sin etiquetas repetidas)", () => {
    for (const definition of VEHICLE_TEMPLATE_CATALOG) {
      assert.doesNotThrow(() => layoutMapSchema.parse(definition.layoutMap), definition.code);
    }
  });

  it("Sprinter 20: 20 asientos (19 de pasajero + 1 de staff); el operador no cuenta", () => {
    assert.deepEqual(getVehicleCapacity(template("SPRINTER_20").layoutMap), {
      total: 20,
      passenger: 19,
      staff: 1,
    });
    const seats = getLayoutSeats(template("SPRINTER_20").layoutMap);
    assert.deepEqual(
      seats.filter((s) => s.kind === "STAFF").map((s) => s.label),
      ["1"],
    );
    // Numeración de la imagen: 2–20 para pasajeros, en orden de lectura.
    assert.deepEqual(
      seats.filter((s) => s.kind === "PASSENGER").map((s) => s.label),
      range(2, 20),
    );
    // El operador está al frente a la izquierda y el staff en la misma fila, a la derecha.
    assert.deepEqual(template("SPRINTER_20").layoutMap[0]?.[0], { type: "DRIVER" });
  });

  it("Autobús 48: asientos 1–48, WC de 2×2 junto a las filas 45–46 y 47–48", () => {
    const layoutMap = template("BUS_48_WC").layoutMap;
    assert.deepEqual(getVehicleCapacity(layoutMap), { total: 48, passenger: 48, staff: 0 });
    assert.deepEqual(labels("BUS_48_WC"), range(1, 48));
    const wcRow = layoutMap.findIndex((row) =>
      row.some((c) => typeof c === "object" && c?.type === "WC"),
    );
    assert.deepEqual(layoutMap[wcRow]?.slice(0, 2), [
      { type: "SEAT", label: "45", kind: "PASSENGER" },
      { type: "SEAT", label: "46", kind: "PASSENGER" },
    ]);
    assert.deepEqual(layoutMap[wcRow]?.[3], { type: "WC", rowSpan: 2, colSpan: 2 });
  });

  it("Autobús 50: asientos 1–50, WC de 1×2 junto a la fila 49–50", () => {
    const layoutMap = template("BUS_50_WC").layoutMap;
    assert.deepEqual(getVehicleCapacity(layoutMap), { total: 50, passenger: 50, staff: 0 });
    assert.deepEqual(labels("BUS_50_WC"), range(1, 50));
    assert.deepEqual(layoutMap.at(-1)?.[3], { type: "WC", rowSpan: 1, colSpan: 2 });
  });

  it("el formato anterior (texto, AISLE, null) sigue siendo válido: todo texto es asiento de pasajero", () => {
    const legacy = [
      ["01", "02", "AISLE", null],
      ["03", "04", "AISLE", "05"],
    ];
    assert.doesNotThrow(() => layoutMapSchema.parse(legacy));
    assert.deepEqual(getVehicleCapacity(legacy), { total: 5, passenger: 5, staff: 0 });
  });

  it("rechaza etiquetas repetidas y croquis sin asientos", () => {
    assert.throws(() => layoutMapSchema.parse([["1", "1"]]), /repetidas/);
    assert.throws(
      () => layoutMapSchema.parse([[{ type: "DRIVER" }, "AISLE"]]),
      /al menos un asiento/,
    );
  });
});

describe("API de plantillas y asignación desde el catálogo", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);

  it("GET /api/vehicle-templates: requiere sesión", async () => {
    const res = await app.inject({ method: "GET", url: "/api/vehicle-templates" });
    assert.equal(res.statusCode, 401);
  });

  it("GET /api/vehicle-templates: devuelve el catálogo con la capacidad calculada", async () => {
    mock.method(db.query.vehicleTemplates, "findMany", (async () => [
      {
        id: TEMPLATE_ID,
        code: "SPRINTER_20",
        name: "Sprinter 20 lugares",
        description: "",
        layoutMap: template("SPRINTER_20").layoutMap,
      },
    ]) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/vehicle-templates",
      cookies: cookies(),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data[0].capacity, { total: 20, passenger: 19, staff: 1 });
  });

  /** Transacción de assignVehicle con la plantilla Sprinter y `seatRight` lugares con anticipo. */
  function templateTx(opts: {
    existingVehicle?: boolean;
    seatRight: number;
    templateFound?: boolean;
  }) {
    const insert = mock.fn(() =>
      chain([{ id: VEHICLE_ID, layoutMap: template("SPRINTER_20").layoutMap }]),
    );
    let updates = 0;
    const update = mock.fn(() => ({
      set: () => chain(updates++ === 0 ? [{ id: TOUR_ID, vehicleId: VEHICLE_ID }] : []),
    }));
    mockTransaction({
      query: {
        vehicles: {
          findFirst: async () =>
            opts.existingVehicle
              ? { id: VEHICLE_ID, layoutMap: template("SPRINTER_20").layoutMap }
              : undefined,
        },
        vehicleTemplates: {
          findFirst: async () =>
            opts.templateFound === false
              ? undefined
              : {
                  id: TEMPLATE_ID,
                  name: "Sprinter 20 lugares",
                  layoutMap: template("SPRINTER_20").layoutMap,
                },
        },
        // Un grupo de `seatRight` lugares con anticipo $0 (derecho a asiento sin pagos).
        bookings: {
          findMany: async () => [
            {
              totalPrice: 1000 * opts.seatRight,
              amountPaid: 0,
              magicToken: { numberPassengers: opts.seatRight },
            },
          ],
        },
      },
      select: () => chain([{ id: TOUR_ID, price: 1000, depositPerPerson: 0 }]),
      insert,
      update,
      delete: () => chain([]),
    });
    return { insert, update };
  }

  const assignTemplate = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/tours/${TOUR_ID}/vehicle`,
      cookies: cookies(),
      payload,
    });

  it("con templateId crea la unidad de la agencia (copia del croquis) y la asigna", async () => {
    const { insert, update } = templateTx({ seatRight: 5 });

    const res = await assignTemplate({ templateId: TEMPLATE_ID });

    assert.equal(res.statusCode, 200);
    assert.equal(insert.mock.callCount(), 1);
    assert.equal(update.mock.callCount(), 2);
    assert.equal(res.json().data.vehicleId, VEHICLE_ID);
  });

  it("con templateId reutiliza la unidad existente de la agencia (no duplica)", async () => {
    const { insert } = templateTx({ existingVehicle: true, seatRight: 5 });

    const res = await assignTemplate({ templateId: TEMPLATE_ID });

    assert.equal(res.statusCode, 200);
    assert.equal(insert.mock.callCount(), 0);
  });

  it("el candado usa los asientos de PASAJERO: 20 con derecho a asiento no caben en la Sprinter (19)", async () => {
    const { update } = templateTx({ existingVehicle: true, seatRight: 20 });

    const res = await assignTemplate({ templateId: TEMPLATE_ID });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /19 asientos de pasajero y 20 pasajeros/);
    assert.equal(update.mock.callCount(), 0);
  });

  it("plantilla inexistente o inactiva → 404", async () => {
    templateTx({ seatRight: 1, templateFound: false });
    const res = await assignTemplate({ templateId: TEMPLATE_ID });
    assert.equal(res.statusCode, 404);
  });

  it("vehicleId y templateId juntos (o ninguno) → 400", async () => {
    const both = await assignTemplate({ vehicleId: VEHICLE_ID, templateId: TEMPLATE_ID });
    const none = await assignTemplate({});
    assert.equal(both.statusCode, 400);
    assert.equal(none.statusCode, 400);
  });

  describe("asientos de un tour con la Sprinter 20", () => {
    function seatTx(staffCapacity: number, otherBlocks = 0) {
      const insert = mock.fn(() => chain(undefined));
      const update = mock.fn(() => chain([{ id: "row" }]));
      mockTransaction({
        query: {
          tours: {
            findFirst: async () => ({
              id: TOUR_ID,
              price: 1000,
              depositPerPerson: 0,
              staffCapacity,
              vehicle: { layoutMap: template("SPRINTER_20").layoutMap },
            }),
          },
          bookingPassengers: {
            findFirst: async () => ({
              id: "bp-1",
              booking: { amountPaid: 0, totalPrice: 1000, magicToken: { numberPassengers: 1 } },
            }),
          },
        },
        select: (() => {
          let call = 0;
          return () => chain(call++ === 0 ? [{ total: otherBlocks, id: "b-1" }] : [{ id: "b-1" }]);
        })(),
        update,
        delete: () => chain(undefined),
        insert,
      });
      return { insert, update };
    }

    const patchSeat = (label: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/seats/${TOUR_ID}/seats/${label}`,
        cookies: cookies(),
        payload,
      });

    it("el asiento de staff del croquis no se asigna a pasajeros (409)", async () => {
      const { update } = seatTx(1);
      const res = await patchSeat("1", { status: "ASSIGNED", passengerId: VEHICLE_ID });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /reservado para el staff/);
      assert.equal(update.mock.callCount(), 0);
    });

    it("una etiqueta que no existe en el croquis → 404 (p. ej. el formato anterior '07')", async () => {
      seatTx(1);
      const res = await patchSeat("07", { status: "ASSIGNED", passengerId: VEHICLE_ID });
      assert.equal(res.statusCode, 404);
    });

    it("liberar una etiqueta del croquis anterior sí se permite (limpieza)", async () => {
      seatTx(1);
      const res = await patchSeat("07", { status: "AVAILABLE", passengerId: null });
      assert.equal(res.statusCode, 200);
    });

    it("el asiento de staff del croquis cuenta para el tope: staffCapacity 1 no deja bloquear más", async () => {
      const { insert } = seatTx(1);
      const res = await patchSeat("5", { status: "BLOCKED" });
      assert.equal(res.statusCode, 409);
      assert.equal(insert.mock.callCount(), 0);
    });

    it("staffCapacity 2 permite bloquear un asiento además del de staff del croquis", async () => {
      const { insert } = seatTx(2);
      const res = await patchSeat("5", { status: "BLOCKED" });
      assert.equal(res.statusCode, 200);
      assert.equal(insert.mock.callCount(), 1);
    });

    it("un asiento de pasajero existente se asigna normalmente", async () => {
      seatTx(1);
      const res = await patchSeat("2", { status: "ASSIGNED", passengerId: VEHICLE_ID });
      assert.equal(res.statusCode, 200);
    });
  });
});
