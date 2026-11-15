import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

const BOOKING_ID = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";

type FakePayment = {
  id: string;
  amount: number;
  type: "PAYMENT" | "REFUND";
  method: string;
  referenceInfo?: string | null;
};

/**
 * Transacción en memoria para el flujo de pagos: guarda los pagos insertados, resuelve la SUMA
 * como lo haría Postgres y aplica a la reserva cada `.update(bookings).set(...)`.
 * Tour: $1,500 por persona, anticipo $500 por persona; grupo de 4 → total $6,000, anticipo $2,000.
 */
function mockBookingLedger(initialStatus: string, existingPayments: FakePayment[] = []) {
  const booking: Record<string, unknown> = {
    id: BOOKING_ID,
    agencyId: AGENCY_A,
    status: initialStatus,
    paymentStatus: "PENDING",
    totalPrice: 6000,
    amountPaid: existingPayments.reduce((sum, p) => sum + p.amount, 0),
  };
  const payments: FakePayment[] = [...existingPayments];

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
          tour: { price: 1500, depositPerPerson: 500 },
          magicToken: { numberPassengers: 4 },
        }),
      },
      payments: {
        findFirst: async () => ({ ...payments[0], agencyId: AGENCY_A, bookingId: BOOKING_ID }),
        // Libro de la reserva (validación de doble anulación).
        findMany: async () =>
          payments.map((p) => ({ type: p.type, referenceInfo: p.referenceInfo })),
      },
    },
    insert: () => ({
      values: (row: FakePayment) => ({
        returning: async () => {
          const saved = { ...row, id: row.id ?? `pay-${payments.length + 1}` };
          payments.push(saved);
          return [saved];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => thenable([{ totalPaid: payments.reduce((sum, p) => sum + p.amount, 0) }]),
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
  return booking;
}

describe("Confirmación automática de reservas (PENDING ⇄ CONFIRMED)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const pay = (amount: number) =>
    app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING_ID}/payments`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { amount, method: "TRANSFER" },
    });

  it("formulario lleno + abono menor al anticipo ($1,500 de $2,000) → sigue PENDING", async () => {
    const booking = mockBookingLedger("PENDING");

    const res = await pay(1500);

    assert.equal(res.statusCode, 201);
    assert.equal(booking.paymentStatus, "PARTIAL");
    assert.equal(booking.status, "PENDING");
  });

  it("al cubrir el anticipo ($1,500 + $500 = $2,000) pasa a CONFIRMED", async () => {
    const booking = mockBookingLedger("PENDING", [
      { id: "pay-1", amount: 1500, type: "PAYMENT", method: "TRANSFER" },
    ]);

    await pay(500);

    assert.equal(booking.amountPaid, 2000);
    assert.equal(booking.status, "CONFIRMED");
  });

  it("sin formulario (AWAITING_REGISTRATION) no se confirma aunque pague el anticipo", async () => {
    const booking = mockBookingLedger("AWAITING_REGISTRATION");

    await pay(3000);

    assert.equal(booking.status, "AWAITING_REGISTRATION");
  });

  it("anular un abono que deja lo pagado bajo el anticipo regresa la reserva a PENDING", async () => {
    const booking = mockBookingLedger("CONFIRMED", [
      { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", amount: 2000, type: "PAYMENT", method: "CASH" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING_ID}/payments/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa/void`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { reason: "Error de captura" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(booking.amountPaid, 0);
    assert.equal(booking.status, "PENDING");
  });
});
