import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { getTourTemporalStatus } from "../src/shared/utils/tour-status.util.js";
import { summarizeRefunds } from "../src/shared/utils/refund.util.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Decisiones del PM (2026-11-14): "Pausado" no existe en el MVP; cancelar un tour es definitivo,
// cancela todas las reservas sin penalización y obliga a reembolsar lo abonado. En un tour
// cancelado el Drawer solo registra reembolsos (excepción al Modo Auditoría).

const TOUR_ID = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
const BOOKING_ID = "c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5";

/**
 * Transacción falsa: cada `select` devuelve, en orden, el resultado indicado; cada
 * `update(tabla).set(valores)` queda registrado.
 */
function fakeTransaction(selectResults: unknown[]) {
  let call = 0;
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const tx = {
    select: () => chain(selectResults[call++] ?? []),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table: getTableName(table), values });
        return chain(undefined);
      },
    }),
  };
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return { updates };
}

describe("Regla del estado temporal: CANCELADO = cancelado por la agencia", () => {
  it("con cancelledAt es CANCELADO sin importar la fecha; sin él, se calcula por fecha", () => {
    assert.equal(getTourTemporalStatus("2099-01-01", "2026-11-14T10:00:00.000Z"), "CANCELADO");
    assert.equal(getTourTemporalStatus("2099-01-01", null), "PRÓXIMO");
    assert.equal(getTourTemporalStatus("2020-01-01", null), "FINALIZADO");
  });
});

describe("summarizeRefunds: saldo a reembolsar (única regla)", () => {
  it("cancelado por la agencia ($0 de retención): se reembolsa todo lo abonado", () => {
    assert.deepEqual(
      summarizeRefunds({
        amountPaid: 2000,
        totalPrice: 0,
        payments: [{ type: "PAYMENT", amount: 2000 }],
      }),
      {
        paidAmount: 2000,
        retainedAmount: 0,
        refundedAmount: 0,
        refundableAmount: 2000,
        refundStatus: "PENDING",
      },
    );
  });

  it("devolución parcial y luego total", () => {
    const partial = summarizeRefunds({
      amountPaid: 1200,
      totalPrice: 0,
      payments: [
        { type: "PAYMENT", amount: 2000 },
        { type: "REFUND", amount: -800, referenceInfo: "SPEI Ref: 98123" },
      ],
    });
    assert.equal(partial.paidAmount, 2000);
    assert.equal(partial.refundableAmount, 1200);
    assert.equal(partial.refundStatus, "PENDING");

    const done = summarizeRefunds({
      amountPaid: 0,
      totalPrice: 0,
      payments: [
        { type: "PAYMENT", amount: 2000 },
        { type: "REFUND", amount: -2000, referenceInfo: "SPEI Ref: 98123" },
      ],
    });
    assert.equal(done.refundStatus, "COMPLETED");
    assert.equal(done.refundedAmount, 2000);
  });

  it("sin dinero abonado no hay nada que reembolsar", () => {
    assert.equal(
      summarizeRefunds({ amountPaid: 0, totalPrice: 0, payments: [] }).refundStatus,
      "NONE",
    );
  });
});

describe("POST /api/tours/:id/cancel (cancelación por la agencia)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cancel = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/tours/${TOUR_ID}/cancel`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload,
    });

  const upcomingTour = {
    id: TOUR_ID,
    departureDateTime: "2099-12-20",
    cancelledAt: null,
    currency: "MXN",
  };
  const activeBookings = [
    { id: "b1", totalPrice: 4000, amountPaid: 2000, paymentStatus: "PARTIAL" },
    { id: "b2", totalPrice: 3000, amountPaid: 1500, paymentStatus: "PARTIAL" },
    { id: "b3", totalPrice: 1500, amountPaid: 0, paymentStatus: "PENDING" },
  ];

  it("guarda motivo y nota, y cancela todas las reservas sin penalización", async () => {
    const { updates } = fakeTransaction([[upcomingTour], activeBookings]);

    const res = await cancel({ reason: "WEATHER", note: "  Pronóstico de tormenta  " });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      {
        cancelledBookings: res.json().data.cancelledBookings,
        refundableTotal: res.json().data.refundableTotal,
      },
      { cancelledBookings: 3, refundableTotal: 3500 },
    );

    const tourUpdate = updates.find((u) => u.table === "tours")!;
    assert.equal(tourUpdate.values.cancellationReason, "WEATHER");
    assert.equal(tourUpdate.values.cancellationNote, "Pronóstico de tormenta");
    assert.ok(tourUpdate.values.cancelledAt);
    assert.equal(tourUpdate.values.updatedByUserId, USER_A); // quién canceló el tour

    const bookingUpdates = updates.filter((u) => u.table === "bookings");
    assert.equal(bookingUpdates.length, 3);
    for (const update of bookingUpdates) {
      assert.equal(update.values.status, "CANCELLED");
      assert.equal(update.values.totalPrice, 0); // sin penalización: se reembolsa todo
    }
    // Pasajeros cancelados y asientos liberados.
    const passengerUpdates = updates.filter((u) => u.table === "booking_passengers");
    assert.equal(passengerUpdates.length, 3);
    assert.equal(passengerUpdates[0]!.values.seatLabel, null);
  });

  it("tour ya cancelado → 409 sin escribir", async () => {
    const { updates } = fakeTransaction([
      [{ ...upcomingTour, cancelledAt: "2026-11-14T10:00:00.000Z" }],
    ]);

    const res = await cancel({ reason: "SECURITY" });

    assert.equal(res.statusCode, 409);
    assert.equal(updates.length, 0);
  });

  it("tour ya finalizado → 409 sin escribir", async () => {
    const { updates } = fakeTransaction([[{ ...upcomingTour, departureDateTime: "2020-01-01" }]]);

    const res = await cancel({ reason: "OTHER" });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /ya finalizó/);
    assert.equal(updates.length, 0);
  });

  it("tour inexistente o de otra agencia → 404", async () => {
    fakeTransaction([[]]);

    assert.equal((await cancel({ reason: "LOW_SALES" })).statusCode, 404);
  });

  it("motivo fuera de la lista o nota de más de 200 caracteres → 400", async () => {
    fakeTransaction([[upcomingTour], []]);

    assert.equal((await cancel({ reason: "LLUVIA" })).statusCode, 400);
    assert.equal((await cancel({ reason: "WEATHER", note: "x".repeat(201) })).statusCode, 400);
  });
});

describe("Pagos en un tour cancelado: solo reembolsos", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  /** Libro de pagos en memoria de una reserva cancelada por la agencia con $2,000 abonados. */
  function cancelledLedger({ tourCancelled = true }: { tourCancelled?: boolean } = {}) {
    const booking: Record<string, unknown> = {
      id: BOOKING_ID,
      agencyId: AGENCY_A,
      status: "CANCELLED",
      paymentStatus: "PARTIAL",
      totalPrice: 0,
      amountPaid: 2000,
    };
    const ledger: { amount: number; type: string }[] = [{ amount: 2000, type: "PAYMENT" }];
    // `for` = `SELECT … FOR UPDATE` (candado de la reserva, lockBookingForUpdate).
    const thenable = (value: unknown): PromiseLike<unknown> & { for: () => unknown } => ({
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
      for: () => thenable(value),
    });
    const tx = {
      query: {
        bookings: {
          findFirst: async () => ({
            ...booking,
            tour: {
              cancelledAt: tourCancelled ? "2026-11-14T10:00:00.000Z" : null,
              price: 1000,
              depositPerPerson: 0,
            },
            magicToken: { numberPassengers: 2 },
          }),
        },
        // Libro de la reserva (devoluciones previas → estado REFUNDED).
        payments: { findMany: async () => ledger.map((entry) => ({ ...entry })) },
      },
      insert: () => ({
        values: (row: { amount: number; type: string }) => ({
          returning: async () => {
            ledger.push(row);
            return [{ ...row, id: `pay-${ledger.length}` }];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => thenable([{ totalPaid: ledger.reduce((sum, p) => sum + p.amount, 0) }]),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          Object.assign(booking, values);
          return { where: () => thenable(undefined) };
        },
      }),
    };
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
    return { booking, ledger };
  }

  const register = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING_ID}/payments`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { method: "TRANSFER", currency: "MXN", ...payload },
    });

  it("reembolso en un tour NO cancelado (canceló el cliente) → 409 sin registrar", async () => {
    const { ledger } = cancelledLedger({ tourCancelled: false });

    const res = await register({ amount: 500, type: "REFUND" });

    assert.equal(res.statusCode, 409);
    assert.match(
      res.json().error,
      /cuando la agencia cancela el tour o cuando la reserva tiene saldo a devolver/,
    );
    assert.equal(ledger.length, 1);
  });

  it("un abono nuevo → 409 sin registrar", async () => {
    const { ledger } = cancelledLedger();

    const res = await register({ amount: 500, type: "PAYMENT" });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /solo se pueden registrar reembolsos/);
    assert.equal(ledger.length, 1);
  });

  it("un reembolso mayor que el saldo a reembolsar → 400 sin registrar", async () => {
    const { ledger } = cancelledLedger();

    const res = await register({ amount: 2500, type: "REFUND" });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /supera el saldo a reembolsar/);
    assert.equal(ledger.length, 1);
  });

  it("reembolso parcial y luego total: el neto llega a $0 y la reserva queda REFUNDED", async () => {
    const { booking, ledger } = cancelledLedger();

    const partial = await register({ amount: 800, type: "REFUND", referenceInfo: "SPEI Ref: 1" });
    assert.equal(partial.statusCode, 201);
    assert.equal(booking.amountPaid, 1200);

    const rest = await register({ amount: 1200, type: "REFUND", referenceInfo: "SPEI Ref: 2" });
    assert.equal(rest.statusCode, 201);
    assert.equal(booking.amountPaid, 0);
    assert.equal(booking.paymentStatus, "REFUNDED"); // antes caía en PAID porque 0 ≥ 0
    assert.equal(booking.status, "CANCELLED"); // terminal
    assert.deepEqual(
      ledger.map((p) => p.amount),
      [2000, -800, -1200],
    );
  });
});

describe("Magic Link de una reserva cancelada por la agencia", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const magicToken = (tour: Record<string, unknown>, amountPaid: number, payments: unknown[]) => ({
    token: "tok",
    numberPassengers: 2,
    tour: {
      id: TOUR_ID,
      title: "Huasteca Potosina",
      departureDateTime: "2026-12-20",
      currency: "MXN",
      price: 1000,
      depositPerPerson: 500,
      boardingPoints: [],
      agency: { id: AGENCY_A, name: "Viajes Xalapa", phone: "2281234567", branding: null },
      ...tour,
    },
    booking: {
      id: BOOKING_ID,
      status: "CANCELLED",
      paymentStatus: "PARTIAL",
      totalPrice: 0,
      amountPaid,
      passengers: [],
      payments,
    },
  });

  it("muestra el motivo y el estado de la devolución, sin la nota interna", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicToken(
        {
          cancelledAt: "2026-11-14T10:00:00.000Z",
          cancellationReason: "WEATHER",
          cancellationNote: "Nota interna del operador",
        },
        1200,
        [
          { id: "p1", type: "PAYMENT", amount: 2000, referenceInfo: null },
          { id: "p2", type: "REFUND", amount: -800, referenceInfo: "SPEI Ref: 98123" },
        ],
      )) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const body = res.json();

    assert.equal(body.flowState, "CANCELLED");
    assert.deepEqual(body.data.cancellation, {
      byAgency: true,
      reason: "WEATHER",
      cancelledAt: "2026-11-14T10:00:00.000Z",
    });
    assert.deepEqual(body.data.refund, {
      paidAmount: 2000,
      retainedAmount: 0,
      refundedAmount: 800,
      refundableAmount: 1200,
      refundStatus: "PENDING",
    });
    assert.ok(!res.body.includes("Nota interna"));
  });

  it("cancelada por el cliente (tour no cancelado): byAgency false y sin montos", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicToken({ cancelledAt: null }, 0, [])) as never);

    const body = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();

    assert.equal(body.data.cancellation.byAgency, false);
    assert.equal(body.data.refund, null);
  });
});
