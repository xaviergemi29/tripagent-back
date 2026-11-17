import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { BookingStatusService } from "../src/modules/bookings/booking-status.service.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Decisiones del PM (2026-11-12): candado físico del vehículo, staff en el croquis y blindaje
// financiero del tour (borrado, moneda/precio congelados, anticipo que resincroniza estados).

const TOUR_ID = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const VEHICLE_ID = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
const BOOKING_ID = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";

/** Devuelve, en orden, el resultado de cada `tx.select(...)`; después del último, `[]`. */
function selectSequence(...results: unknown[]) {
  let call = 0;
  return mock.fn(() => chain(results[call++] ?? []));
}

/** `update().set(payload).where().returning()`: guarda cada payload y resuelve `returning`. */
function updateSpy(returning: unknown[] = [{ id: TOUR_ID }]) {
  const payloads: Record<string, unknown>[] = [];
  const update = mock.fn(() => ({
    set: (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return chain(returning);
    },
  }));
  return { update, payloads };
}

function mockTransaction(tx: Record<string, unknown>) {
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
}

describe("Ciclo de vida del tour", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);

  describe("DELETE /api/tours/:id — no se borra un tour con reservas o dinero", () => {
    it("con reservas activas → 409 y no borra", async () => {
      const { update } = updateSpy();
      mockTransaction({
        select: selectSequence(
          [{ id: TOUR_ID, currency: "MXN" }],
          [{ activeBookings: 2, totalPaid: "0" }],
        ),
        update,
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /2 reserva\(s\) activa\(s\)/);
      assert.equal(update.mock.callCount(), 0);
    });

    it("sin reservas activas pero con dinero abonado → 409 y no borra", async () => {
      const { update } = updateSpy();
      mockTransaction({
        select: selectSequence(
          [{ id: TOUR_ID, currency: "MXN" }],
          [{ activeBookings: 0, totalPaid: "500.00" }],
        ),
        update,
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /Reembolsa los abonos/);
      assert.equal(update.mock.callCount(), 0);
    });

    it("sin reservas activas ni dinero → 200 (borrado lógico)", async () => {
      const { update, payloads } = updateSpy([{ id: TOUR_ID }]);
      mockTransaction({
        select: selectSequence(
          [{ id: TOUR_ID, currency: "MXN" }],
          [{ activeBookings: 0, totalPaid: "0" }],
        ),
        update,
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
      });

      assert.equal(res.statusCode, 200);
      assert.ok(payloads[0]?.deletedAt);
    });

    it("tour inexistente o de otra agencia → 404", async () => {
      mockTransaction({ select: selectSequence([]) });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
      });

      assert.equal(res.statusCode, 404);
    });
  });

  describe("PATCH /api/tours/:id — moneda y precio congelados, anticipo resincroniza", () => {
    const current = {
      maxCapacity: 20,
      staffCapacity: 0,
      price: 1000,
      currency: "MXN",
      depositPerPerson: 500,
      brochureUrl: null,
    };

    it("cambiar la moneda con pagos registrados → 409 y no actualiza", async () => {
      const { update } = updateSpy();
      mockTransaction({ select: selectSequence([current], [{ id: "payment-1" }]), update });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { currency: "USD" },
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya tiene pagos registrados/);
      assert.equal(update.mock.callCount(), 0);
    });

    it("cambiar el precio con pagos registrados → 409", async () => {
      mockTransaction({ select: selectSequence([current], [{ id: "payment-1" }]) });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { price: 1200 },
      });

      assert.equal(res.statusCode, 409);
    });

    it("reenviar la misma moneda y precio (formulario completo) → 200 sin consultar pagos", async () => {
      const select = selectSequence([current]);
      const { update } = updateSpy();
      mockTransaction({ select, update });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { currency: "MXN", price: 1000, title: "Nuevo título del tour" },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(select.mock.callCount(), 1); // solo la lectura del tour
    });

    it("cambiar el precio sin pagos → 200", async () => {
      const { update } = updateSpy();
      mockTransaction({ select: selectSequence([current], []), update });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { price: 1200 },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(update.mock.callCount(), 1);
    });

    // Decisión del PM (2026-11-14): la capacidad vendible no puede quedar bajo los ocupados.
    /** Reservas activas del tour: 12 lugares ocupados (8 por token + 4 por total / precio). */
    const occupiedTx = () => ({
      bookings: {
        findMany: mock.fn(async () => [
          { totalPrice: 8000, magicToken: { numberPassengers: 8 } },
          { totalPrice: 4000, magicToken: null },
        ]),
      },
    });

    it("reducir la capacidad total por debajo de los ocupados → 409 y no actualiza", async () => {
      const { update } = updateSpy();
      mockTransaction({ select: selectSequence([current]), update, query: occupiedTx() });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { maxCapacity: 11 },
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /11 lugares a la venta: el tour ya tiene 12 lugares ocupados/);
      assert.equal(update.mock.callCount(), 0);
    });

    it("subir los lugares de staff hasta dejar la vendible bajo los ocupados → 409", async () => {
      const { update } = updateSpy();
      mockTransaction({ select: selectSequence([current]), update, query: occupiedTx() });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { staffCapacity: 9 }, // 20 − 9 = 11 < 12
      });

      assert.equal(res.statusCode, 409);
      assert.equal(update.mock.callCount(), 0);
    });

    it("capacidad vendible igual a los ocupados → 200", async () => {
      const { update } = updateSpy();
      mockTransaction({ select: selectSequence([current]), update, query: occupiedTx() });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { maxCapacity: 14, staffCapacity: 2 }, // 12 vendibles = 12 ocupados
      });

      assert.equal(res.statusCode, 200);
      assert.equal(update.mock.callCount(), 1);
    });

    it("un PATCH parcial solo escribe los campos enviados (sin defaults)", async () => {
      const { update, payloads } = updateSpy();
      mockTransaction({ select: selectSequence([current]), update });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { title: "Nuevo título del tour" },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(Object.keys(payloads[0]!).sort(), ["title", "updatedAt"]);
    });

    it("el tour ya no tiene políticas propias: un `policies` enviado se ignora", async () => {
      // Decisión del PM (MVP): solo existen las políticas generales de la agencia; lo particular
      // de cada tour va en las Instrucciones Post-Pago.
      const { update, payloads } = updateSpy();
      mockTransaction({ select: selectSequence([current], [current]), update });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { policies: "Llevar identificación.", postPaymentInstructions: "  Botas.  " },
      });

      assert.equal(res.statusCode, 200);
      assert.equal("policies" in payloads[0]!, false);
      assert.equal(payloads[0]!.postPaymentInstructions, "Botas.");
    });

    it("cambiar el anticipo recalcula el estado de cada reserva activa", async () => {
      const syncStatus = mock.method(BookingStatusService, "syncStatus", (async () => {}) as never);
      mockTransaction({
        select: selectSequence([current], [{ id: "b-1" }, { id: "b-2" }]),
        update: updateSpy().update,
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { depositPerPerson: 800 },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(syncStatus.mock.callCount(), 2);
    });

    it("sin cambio de anticipo no se recalculan estados", async () => {
      const syncStatus = mock.method(BookingStatusService, "syncStatus", (async () => {}) as never);
      mockTransaction({ select: selectSequence([current]), update: updateSpy().update });

      await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: cookies(),
        payload: { depositPerPerson: 500 },
      });

      assert.equal(syncStatus.mock.callCount(), 0);
    });
  });

  describe("PATCH /api/tours/:id/vehicle — candado físico", () => {
    const tourRow = { id: TOUR_ID, price: 1000, depositPerPerson: 500 };
    // Grupo de 3 con anticipo cubierto (3 × $500 = $1,500).
    const paidGroupOf3 = {
      totalPrice: 3000,
      amountPaid: 1500,
      magicToken: { numberPassengers: 3 },
    };
    // Grupo de 4 SIN anticipo cubierto: no cuenta para el candado.
    const unpaidGroupOf4 = { totalPrice: 4000, amountPaid: 0, magicToken: { numberPassengers: 4 } };

    function vehicleTx(
      layoutMap: (string | null)[][],
      released: unknown[] = [],
      tour: Record<string, unknown> = tourRow,
    ) {
      let updates = 0;
      const update = mock.fn(() => ({
        set: () => chain(updates++ === 0 ? [{ id: TOUR_ID, vehicleId: VEHICLE_ID }] : released),
      }));
      const del = mock.fn(() => chain([{ seatLabel: "30" }]));
      mockTransaction({
        query: {
          vehicles: { findFirst: async () => ({ layoutMap }) },
          bookings: { findMany: async () => [paidGroupOf3, unpaidGroupOf4] },
        },
        select: () => chain([tour]),
        update,
        delete: del,
      });
      return { update, del };
    }

    it("vehículo más chico que los pasajeros con derecho a asiento → 409 sin escribir", async () => {
      const { update, del } = vehicleTx([["01", "AISLE", "02"]]); // 2 asientos < 3

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}/vehicle`,
        cookies: cookies(),
        payload: { vehicleId: VEHICLE_ID },
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /2 asientos de pasajero y 3 pasajeros/);
      assert.equal(update.mock.callCount(), 0);
      assert.equal(del.mock.callCount(), 0);
    });

    it("vehículo suficiente → 200 y reporta los asientos liberados (solo pasajeros activos)", async () => {
      vehicleTx(
        [
          ["01", "02", "AISLE", "03"],
          [null, "04", "AISLE", "05"],
        ],
        [
          { seatLabel: "A1", status: "ACTIVE" },
          { seatLabel: "09", status: "CANCELLED" },
        ],
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}/vehicle`,
        cookies: cookies(),
        // `resetOrphans` ya no existe: si un cliente viejo lo manda, se ignora.
        payload: { vehicleId: VEHICLE_ID, resetOrphans: false },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data.releasedSeats, { passengers: 1, blocked: 1 });
    });

    // Solo se cambia de unidad mientras el tour es PRÓXIMO (petición del usuario, 2026-11-17).
    const shiftDays = (days: number) => {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const bigLayout = [
      ["01", "02", "AISLE", "03"],
      [null, "04", "AISLE", "05"],
    ];

    for (const [label, overrides, message] of [
      [
        "EN CURSO",
        { departureDateTime: shiftDays(-1), returnDate: shiftDays(1) },
        /ya está en curso/,
      ],
      ["FINALIZADO", { departureDateTime: shiftDays(-10), returnDate: shiftDays(-8) }, /finalizó/],
      [
        "CANCELADO",
        { departureDateTime: shiftDays(5), cancelledAt: "2026-11-14T10:00:00.000Z" },
        /cancelado/,
      ],
    ] as const) {
      it(`tour ${label} con unidad → 409 al cambiarla, sin escribir`, async () => {
        const { update, del } = vehicleTx(bigLayout, [], {
          ...tourRow,
          vehicleId: "otra-unidad",
          ...overrides,
        });

        const res = await app.inject({
          method: "PATCH",
          url: `/api/tours/${TOUR_ID}/vehicle`,
          cookies: cookies(),
          payload: { vehicleId: VEHICLE_ID },
        });

        assert.equal(res.statusCode, 409);
        assert.match(res.json().error, message);
        assert.equal(update.mock.callCount(), 0);
        assert.equal(del.mock.callCount(), 0);
      });
    }

    it("tour EN CURSO sin unidad todavía → sí se puede asignar la primera", async () => {
      vehicleTx(bigLayout, [], {
        ...tourRow,
        vehicleId: null,
        departureDateTime: shiftDays(0),
        returnDate: shiftDays(1),
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}/vehicle`,
        cookies: cookies(),
        payload: { vehicleId: VEHICLE_ID },
      });

      assert.equal(res.statusCode, 200);
    });
  });

  describe("PATCH /api/seats/:tourId/seats/:label BLOCKED — tope de staff", () => {
    function seatTx(staffCapacity: number, otherBlocks: number) {
      const insert = mock.fn(() => chain(undefined));
      mockTransaction({
        query: {
          tours: {
            findFirst: async () => ({
              id: TOUR_ID,
              price: 1000,
              depositPerPerson: 0,
              staffCapacity,
            }),
          },
        },
        // 1) candado del tour (FOR UPDATE), 2) conteo de bloqueos en otras etiquetas,
        // 3) reservas del tour.
        select: selectSequence([{ id: TOUR_ID }], [{ total: otherBlocks }], [{ id: BOOKING_ID }]),
        update: () => chain([]),
        delete: () => chain(undefined),
        insert,
      });
      return { insert };
    }

    const block = () =>
      app.inject({
        method: "PATCH",
        url: `/api/seats/${TOUR_ID}/seats/01`,
        cookies: cookies(),
        payload: { status: "BLOCKED" },
      });

    it("con los lugares de staff ya bloqueados → 409 sin insertar", async () => {
      const { insert } = seatTx(1, 1);
      const res = await block();
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /Ya están ocupados los 1 lugar/);
      assert.equal(insert.mock.callCount(), 0);
    });

    it("tour sin lugares de staff → 409", async () => {
      seatTx(0, 0);
      const res = await block();
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /no tiene lugares de staff/);
    });

    it("con cupo de staff disponible → 200 e inserta el bloqueo", async () => {
      const { insert } = seatTx(2, 1);
      const res = await block();
      assert.equal(res.statusCode, 200);
      assert.equal(insert.mock.callCount(), 1);
    });
  });

  describe("PATCH /api/bookings/:id/cancel-full — libera asientos", () => {
    it("los pasajeros cancelados quedan sin seatLabel", async () => {
      const { update, payloads } = updateSpy([]);
      mockTransaction({
        query: {
          bookings: {
            findFirst: async () => ({
              id: BOOKING_ID,
              status: "CONFIRMED",
              totalPrice: 2000,
              amountPaid: 1000,
              paymentStatus: "PARTIAL",
            }),
          },
        },
        // Candado de la reserva (lockBookingForUpdate).
        select: () => chain([{ id: BOOKING_ID }]),
        update,
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/bookings/${BOOKING_ID}/cancel-full`,
        cookies: cookies(),
        // Retención = lo abonado: cuando cancela el cliente no puede ser menor (2026-11-17).
        payload: { penaltyAmount: 1000 },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(payloads[0]?.status, "CANCELLED");
      assert.equal(payloads[0]?.seatLabel, null);
    });
  });
});
