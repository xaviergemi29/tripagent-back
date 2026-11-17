import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  createTestApp,
  sessionCookie,
  type TestApp,
} from "./helpers.js";
import { createFakeLedgerDb, type FakeStore } from "./fake-ledger-db.js";
import { sumOccupiedSeats } from "../src/shared/utils/booking-rules.util.js";
import { derivePaymentStatus } from "../src/shared/utils/payment-status.util.js";

/**
 * Flujos de dinero y de grupo de punta a punta (ruta → servicio → "base" en memoria), 2026-11-17:
 * 1. Abono · 2. Anulación de un abono · 3. Cancelación de la reserva · 4. Baja de un acompañante.
 * Cada caso revisa la reserva, sus pasajeros, el libro de pagos y los lugares ocupados, y que un
 * rechazo no escriba nada (ni deje actualizaciones parciales).
 *
 * Escenario base: tour de $1,000 por persona con anticipo de $300 por persona. Reserva de 3 lugares
 * ($3,000; anticipo requerido $900) con titular (asiento 1) y dos acompañantes (asiento 2 y sin
 * asiento), formulario lleno (PENDING) y sin pagos.
 */

const TOUR = randomUUID();
const BOOKING = randomUUID();
const OTHER_BOOKING = randomUUID();
const TITULAR = randomUUID();
const COMPANION_1 = randomUUID();
const COMPANION_2 = randomUUID();
const OTHER_TITULAR = randomUUID();

interface ScenarioOptions {
  /** Lugares apartados (magicToken.numberPassengers). */
  seats?: number;
  /** Acompañantes registrados (activos) además del titular. */
  companions?: string[];
  /** Abonos previos (positivos) o reembolsos (negativos, type REFUND). */
  ledger?: { amount: number; type?: "PAYMENT" | "REFUND"; referenceInfo?: string }[];
  status?: string;
  totalPrice?: number;
  tourCancelled?: boolean;
  /** Precio pactado por lugar guardado en la reserva (`null` = reserva anterior a la columna). */
  unitPrice?: number | null;
  /** Precio ACTUAL del tour (puede haber cambiado después de apartar). */
  tourPrice?: number;
}

function scenario({
  seats = 3,
  companions = [COMPANION_1, COMPANION_2],
  ledger = [],
  status = "PENDING",
  totalPrice = 1000 * seats,
  tourCancelled = false,
  unitPrice = 1000,
  tourPrice = 1000,
}: ScenarioOptions = {}) {
  const payments = ledger.map((entry) => ({
    id: randomUUID(),
    agencyId: AGENCY_A,
    bookingId: BOOKING,
    amount: entry.amount,
    type: entry.type ?? "PAYMENT",
    method: "TRANSFER",
    currency: "MXN",
    referenceInfo: entry.referenceInfo ?? null,
  }));
  const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const passenger = (travelerId: string, isTitular: boolean, seatLabel: string | null) => ({
    id: randomUUID(),
    bookingId: BOOKING,
    travelerId,
    isTitular,
    status: "ACTIVE",
    seatLabel,
    passengerType: "ADULT",
  });

  const store: FakeStore = {
    tours: [
      {
        id: TOUR,
        agencyId: AGENCY_A,
        price: tourPrice,
        depositPerPerson: 300,
        currency: "MXN",
        cancelledAt: tourCancelled ? "2026-11-14T10:00:00.000Z" : null,
      },
    ],
    bookings: [
      {
        id: BOOKING,
        agencyId: AGENCY_A,
        tourId: TOUR,
        travelerId: TITULAR,
        status,
        paymentStatus: derivePaymentStatus({ amountPaid, totalPrice }),
        totalPrice,
        unitPrice,
        amountPaid,
        deletedAt: null,
      },
      // Otra reserva del mismo tour: ninguna operación debe tocarla.
      {
        id: OTHER_BOOKING,
        agencyId: AGENCY_A,
        tourId: TOUR,
        travelerId: OTHER_TITULAR,
        status: "CONFIRMED",
        paymentStatus: "PAID",
        totalPrice: 1000,
        unitPrice: 1000,
        amountPaid: 1000,
        deletedAt: null,
      },
    ],
    bookingPassengers: [
      passenger(TITULAR, true, "1"),
      ...companions.map((id, index) => passenger(id, false, index === 0 ? "2" : null)),
      { ...passenger(OTHER_TITULAR, true, "9"), bookingId: OTHER_BOOKING },
    ],
    magicTokens: [
      { id: randomUUID(), bookingId: BOOKING, numberPassengers: seats },
      { id: randomUUID(), bookingId: OTHER_BOOKING, numberPassengers: 1 },
    ],
    payments,
  };
  return createFakeLedgerDb(store);
}

/** Lugares ocupados del tour con la misma regla que el cupo (regla 12): reservas no canceladas. */
function occupiedSeats(fake: ReturnType<typeof scenario>): number {
  const rows = fake.store.bookings
    .filter((b) => b.status !== "CANCELLED" && !b.deletedAt)
    .map((b) => ({
      totalPrice: Number(b.totalPrice),
      numberPassengers: fake.token(String(b.id))?.numberPassengers as number,
    }));
  return sumOccupiedSeats(rows, 1000);
}

/** Copia de lo que nunca debe cambiar al operar sobre BOOKING. */
function snapshotOtherBooking(fake: ReturnType<typeof scenario>) {
  return structuredClone({
    booking: fake.booking(OTHER_BOOKING),
    passenger: fake.passenger(OTHER_BOOKING, OTHER_TITULAR),
    token: fake.token(OTHER_BOOKING),
  });
}

describe("Flujos financieros y de grupo (de punta a punta)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);

  const pay = (amount: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING}/payments`,
      cookies: cookies(),
      payload: { amount, method: "TRANSFER", currency: "MXN", ...extra },
    });

  const voidPayment = (paymentId: string) =>
    app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING}/payments/${paymentId}/void`,
      cookies: cookies(),
      payload: { reason: "Error de captura" },
    });

  const cancelFull = (penaltyAmount: number) =>
    app.inject({
      method: "PATCH",
      url: `/api/bookings/${BOOKING}/cancel-full`,
      cookies: cookies(),
      payload: { penaltyAmount },
    });

  const dropPassenger = (travelerId: string, penaltyAmount = 0) =>
    app.inject({
      method: "PATCH",
      url: `/api/bookingPassengers/${BOOKING}/passengers/${travelerId}/cancel`,
      cookies: cookies(),
      payload: { penaltyAmount },
    });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("1. Abono", () => {
    it("registra el movimiento y actualiza pagado, saldo y estado de pago (PARTIAL)", async () => {
      const fake = scenario();
      const res = await pay(500);

      assert.equal(res.statusCode, 201);
      const ledger = fake.paymentsOf(BOOKING);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.amount, 500);
      assert.equal(ledger[0]!.type, "PAYMENT");
      assert.equal(fake.booking(BOOKING).amountPaid, 500);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PARTIAL");
      assert.deepEqual(res.json().data.bookingBalance, {
        totalPrice: 3000,
        amountPaid: 500,
        remainingBalance: 2500,
        paymentStatus: "PARTIAL",
      });
      // Abajo del anticipo requerido ($900): la reserva sigue PENDING.
      assert.equal(fake.booking(BOOKING).status, "PENDING");
    });

    it("al cubrir el anticipo la reserva pasa a CONFIRMED; al liquidar, PAID con saldo $0", async () => {
      const fake = scenario();
      await pay(500);
      await pay(400);
      assert.equal(fake.booking(BOOKING).status, "CONFIRMED");
      assert.equal(fake.booking(BOOKING).paymentStatus, "PARTIAL");

      const res = await pay(2100);
      assert.equal(fake.booking(BOOKING).amountPaid, 3000);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PAID");
      assert.equal(res.json().data.bookingBalance.remainingBalance, 0);
      assert.equal(fake.paymentsOf(BOOKING).length, 3);
    });

    it("no toca a los pasajeros, sus asientos, el tamaño del grupo ni otras reservas", async () => {
      const fake = scenario();
      const passengersBefore = structuredClone(
        fake.store.bookingPassengers.filter((p) => p.bookingId === BOOKING),
      );
      const other = snapshotOtherBooking(fake);
      const occupiedBefore = occupiedSeats(fake);

      await pay(900);

      assert.deepEqual(
        fake.store.bookingPassengers.filter((p) => p.bookingId === BOOKING),
        passengersBefore,
      );
      assert.equal(fake.token(BOOKING).numberPassengers, 3);
      assert.equal(occupiedSeats(fake), occupiedBefore);
      assert.deepEqual(snapshotOtherBooking(fake), other);
    });

    it("monto 0 o negativo → 400 sin escribir", async () => {
      const fake = scenario();
      for (const amount of [0, -100]) {
        const res = await pay(amount);
        assert.equal(res.statusCode, 400);
      }
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
    });

    it("reserva de otra agencia → 404 sin escribir", async () => {
      const fake = scenario();
      const res = await app.inject({
        method: "POST",
        url: `/api/payments/${BOOKING}/payments`,
        cookies: sessionCookie(app, AGENCY_B, USER_A),
        payload: { amount: 500, method: "TRANSFER" },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(fake.writes.length, 0);
    });

    it("tour cancelado por la agencia → abono 409 sin escribir", async () => {
      const fake = scenario({ tourCancelled: true, status: "CANCELLED", totalPrice: 0 });
      const res = await pay(500);
      assert.equal(res.statusCode, 409);
      assert.equal(fake.writes.length, 0);
    });

    it("reembolso en un tour que la agencia no canceló → 409 sin escribir", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }] });
      const res = await pay(100, { type: "REFUND" });
      assert.equal(res.statusCode, 409);
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).amountPaid, 900);
    });

    it("abono mayor al saldo pendiente → 400 con el saldo en el mensaje, sin escribir", async () => {
      // Le faltan $500 y se teclea $5,000 (decisión del usuario, 2026-11-17: antes se aceptaba).
      const fake = scenario({ ledger: [{ amount: 2500 }] });
      const res = await pay(5000);
      assert.equal(res.statusCode, 400);
      assert.equal(
        res.json().error,
        "El abono no puede superar el saldo pendiente de $500.00 MXN.",
      );
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).amountPaid, 2500);
    });

    it("abono exactamente igual al saldo pendiente → se acepta y liquida", async () => {
      const fake = scenario({ ledger: [{ amount: 2500 }] });
      const res = await pay(500);
      assert.equal(res.statusCode, 201);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PAID");
    });

    it("reserva ya liquidada: cualquier abono → 400 (saldo pendiente $0.00)", async () => {
      const fake = scenario({ ledger: [{ amount: 3000 }] });
      const res = await pay(1);
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /saldo pendiente de \$0\.00 MXN/);
      assert.equal(fake.writes.length, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("2. Anulación de un abono", () => {
    it("crea un contra-asiento ligado al abono, recalcula pagado y estado, y la reserva vuelve a PENDING", async () => {
      const fake = scenario();
      await pay(500);
      await pay(400);
      assert.equal(fake.booking(BOOKING).status, "CONFIRMED");
      const second = fake.paymentsOf(BOOKING)[1]!;

      const res = await voidPayment(String(second.id));

      assert.equal(res.statusCode, 200);
      const ledger = fake.paymentsOf(BOOKING);
      assert.equal(ledger.length, 3);
      const voidEntry = ledger[2]!;
      assert.equal(voidEntry.type, "REFUND");
      assert.equal(voidEntry.amount, -400);
      assert.match(String(voidEntry.referenceInfo), new RegExp(`\\(Ref: ${second.id}\\)`));
      // El abono original no se borra ni se modifica (libro de solo inserción).
      assert.equal(ledger[1]!.amount, 400);
      assert.equal(fake.booking(BOOKING).amountPaid, 500);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PARTIAL");
      // $500 < anticipo requerido $900: deja de estar confirmada.
      assert.equal(fake.booking(BOOKING).status, "PENDING");
    });

    it("anular dos veces el mismo abono → 409 sin un segundo contra-asiento", async () => {
      const fake = scenario({ ledger: [{ amount: 500 }] });
      const [payment] = fake.paymentsOf(BOOKING);
      assert.equal((await voidPayment(String(payment!.id))).statusCode, 200);
      const writesAfterFirst = fake.writes.length;

      const res = await voidPayment(String(payment!.id));

      assert.equal(res.statusCode, 409);
      assert.equal(fake.paymentsOf(BOOKING).length, 2);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
      assert.equal(fake.writes.length, writesAfterFirst);
    });

    it("anular el único abono deja pagado $0 y estado PENDING", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }], status: "CONFIRMED" });
      const res = await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PENDING");
      assert.equal(fake.booking(BOOKING).status, "PENDING");
    });

    it("una anulación (contra-asiento) no se puede anular → 409 sin escribir", async () => {
      const fake = scenario({ ledger: [{ amount: 500 }] });
      await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      const writesBefore = fake.writes.length;
      const voidEntry = fake.paymentsOf(BOOKING)[1]!;

      const res = await voidPayment(String(voidEntry.id));

      assert.equal(res.statusCode, 409);
      assert.equal(fake.writes.length, writesBefore);
    });

    it("abono inexistente → 404 sin escribir", async () => {
      const fake = scenario({ ledger: [{ amount: 500 }] });
      const res = await voidPayment(randomUUID());
      assert.equal(res.statusCode, 404);
      assert.equal(fake.writes.length, 0);
    });

    it("no toca a los pasajeros ni a otras reservas", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }] });
      const passengersBefore = structuredClone(
        fake.store.bookingPassengers.filter((p) => p.bookingId === BOOKING),
      );
      const other = snapshotOtherBooking(fake);
      await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.deepEqual(
        fake.store.bookingPassengers.filter((p) => p.bookingId === BOOKING),
        passengersBefore,
      );
      assert.deepEqual(snapshotOtherBooking(fake), other);
    });

    it("tour cancelado: anular un abono ya reembolsado (neto quedaría negativo) → 409 sin escribir", async () => {
      const fake = scenario({
        tourCancelled: true,
        status: "CANCELLED",
        totalPrice: 0,
        ledger: [{ amount: 1000 }, { amount: -1000, type: "REFUND", referenceInfo: "SPEI 123" }],
      });
      const res = await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya se devolvió/);
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
    });

    it("tour cancelado: abono mal capturado anulado después del reembolso → neto $0 y REFUNDED", async () => {
      const fake = scenario({
        tourCancelled: true,
        status: "CANCELLED",
        totalPrice: 0,
        ledger: [
          { amount: 1000 },
          { amount: 200 }, // captura duplicada
          { amount: -1000, type: "REFUND", referenceInfo: "SPEI 123" },
        ],
      });
      const res = await voidPayment(String(fake.paymentsOf(BOOKING)[1]!.id));
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
      assert.equal(fake.booking(BOOKING).paymentStatus, "REFUNDED");
    });

    it("reserva cancelada sin retención (total $0): anular su abono deja PENDING, no PAID", async () => {
      const fake = scenario({ status: "CANCELLED", totalPrice: 0, ledger: [{ amount: 500 }] });
      const res = await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).amountPaid, 0);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PENDING");
    });

    it("cancelada por el cliente: anular un abono mal capturado baja la retención a lo realmente abonado", async () => {
      // Decisión del usuario (2026-11-17). $1,000 SPEI + $500 en efectivo que nunca llegó; Beto
      // cancela con "Sin Devolución" (retención $1,500) y en el corte se anula el efectivo.
      const fake = scenario({
        ledger: [{ amount: 1000, referenceInfo: "SPEI 4821" }, { amount: 500 }],
        status: "CONFIRMED",
      });
      assert.equal((await cancelFull(1500)).statusCode, 200);
      const cash = fake.paymentsOf(BOOKING)[1]!;

      const res = await voidPayment(String(cash.id));

      assert.equal(res.statusCode, 200);
      const booking = fake.booking(BOOKING);
      assert.equal(booking.amountPaid, 1000);
      assert.equal(booking.totalPrice, 1000); // antes se quedaba en $1,500 ("debe" $500)
      assert.equal(booking.paymentStatus, "PAID");
      assert.equal(booking.status, "CANCELLED");
      assert.equal(res.json().data.bookingBalance.remainingBalance, 0);
      // El contra-asiento queda en el libro; el abono original no se toca.
      assert.equal(fake.paymentsOf(BOOKING).length, 3);
    });

    it("cancelada por el cliente: anular todo deja retención $0 y estado PENDING", async () => {
      const fake = scenario({ ledger: [{ amount: 500 }] });
      await cancelFull(500);
      await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.equal(fake.booking(BOOKING).totalPrice, 0);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PENDING");
    });

    it("reserva activa: anular un abono NO cambia el total de la reserva", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }] });
      await voidPayment(String(fake.paymentsOf(BOOKING)[0]!.id));
      assert.equal(fake.booking(BOOKING).totalPrice, 3000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("3. Cancelación de la reserva completa", () => {
    it("cancela la reserva y a todos sus pasajeros, libera asientos y lugares; el libro no cambia", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }], status: "CONFIRMED" });
      const ledgerBefore = structuredClone(fake.paymentsOf(BOOKING));
      const other = snapshotOtherBooking(fake);
      assert.equal(occupiedSeats(fake), 4);

      const res = await cancelFull(1000);

      assert.equal(res.statusCode, 200);
      const booking = fake.booking(BOOKING);
      assert.equal(booking.status, "CANCELLED");
      assert.equal(booking.totalPrice, 1000); // el nuevo total es la retención
      assert.equal(booking.amountPaid, 900); // lo abonado no se mueve
      assert.equal(booking.paymentStatus, "PARTIAL"); // debe $100 de la retención
      for (const travelerId of [TITULAR, COMPANION_1, COMPANION_2]) {
        const passenger = fake.passenger(BOOKING, travelerId);
        assert.equal(passenger.status, "CANCELLED");
        assert.equal(passenger.seatLabel, null);
      }
      assert.deepEqual(fake.paymentsOf(BOOKING), ledgerBefore);
      assert.equal(occupiedSeats(fake), 1); // solo la otra reserva
      assert.deepEqual(snapshotOtherBooking(fake), other);
      assert.deepEqual(res.json().data.financialSummary, {
        previousTotal: 3000,
        newTotal: 1000,
        amountPaid: 900,
        hasSurplus: false,
        surplusAmount: 0,
      });
    });

    it("retención menor a lo abonado → 400 sin escribir (nunca queda un saldo a favor sin salida)", async () => {
      // Decisión del usuario (2026-11-17): cuando cancela el cliente, la agencia retiene lo pagado.
      const fake = scenario({ ledger: [{ amount: 900 }], status: "CONFIRMED" });
      for (const penalty of [500, 0]) {
        const res = await cancelFull(penalty);
        assert.equal(res.statusCode, 400);
        assert.match(res.json().error, /no puede ser menor a lo ya abonado \(\$900\.00 MXN\)/);
      }
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).status, "CONFIRMED");
    });

    it('retención = lo abonado ("Sin Devolución"): total = pagado, saldo $0, PAID y sin saldo a favor', async () => {
      const fake = scenario({ ledger: [{ amount: 1500 }], status: "CONFIRMED" });
      const res = await cancelFull(1500);
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 1500);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PAID");
      assert.equal(res.json().data.financialSummary.surplusAmount, 0);
    });

    it("sin pagos y sin retención: total $0 y estado de pago PENDING", async () => {
      const fake = scenario();
      await cancelFull(0);
      assert.equal(fake.booking(BOOKING).totalPrice, 0);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PENDING");
    });

    it("reserva anterior pagada de más: la retención puede llegar hasta lo abonado", async () => {
      // Antes de bloquear los abonos sobre el saldo pudo quedar pagado > total.
      const fake = scenario({ ledger: [{ amount: 3200 }] });
      const res = await cancelFull(3200);
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 3200);
      assert.equal(res.json().data.financialSummary.surplusAmount, 0);
    });

    it("retención mayor al total → 400 sin escribir", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }] });
      const res = await cancelFull(3001);
      assert.equal(res.statusCode, 400);
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.booking(BOOKING).status, "PENDING");
      assert.equal(fake.passenger(BOOKING, TITULAR).status, "ACTIVE");
    });

    it("cancelar dos veces → 409 sin escribir de nuevo", async () => {
      const fake = scenario();
      assert.equal((await cancelFull(0)).statusCode, 200);
      const writesAfterFirst = fake.writes.length;
      const res = await cancelFull(0);
      assert.equal(res.statusCode, 409);
      assert.equal(fake.writes.length, writesAfterFirst);
    });

    it("cancelada: ya no se da de baja a un acompañante (409 sin escribir)", async () => {
      const fake = scenario();
      await cancelFull(0);
      const writesAfterCancel = fake.writes.length;
      const res = await dropPassenger(COMPANION_1);
      assert.equal(res.statusCode, 409);
      assert.equal(fake.writes.length, writesAfterCancel);
    });

    it("cancelada por el cliente: queda congelada para abonos (409 sin escribir)", async () => {
      // Decisión del usuario (2026-11-17): antes se aceptaba "para cubrir la retención".
      const fake = scenario({ ledger: [{ amount: 900 }] });
      await cancelFull(1000);
      const writesAfterCancel = fake.writes.length;
      const res = await pay(100);
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /cancelada: ya no se pueden registrar abonos/);
      assert.equal(fake.writes.length, writesAfterCancel);
      assert.equal(fake.booking(BOOKING).amountPaid, 900);
    });

    it("por porcentaje (PATCH /:id/cancel): retención = total × %", async () => {
      const fake = scenario();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/bookings/${BOOKING}/cancel`,
        cookies: cookies(),
        payload: { penaltyPercentage: 50 },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 1500);
      assert.equal(fake.booking(BOOKING).status, "CANCELLED");
    });

    it("por porcentaje con retención menor a lo abonado → 400 sin escribir", async () => {
      const fake = scenario({ ledger: [{ amount: 2000 }] });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/bookings/${BOOKING}/cancel`,
        cookies: cookies(),
        payload: { penaltyPercentage: 50 }, // $1,500 < $2,000 abonados
      });
      assert.equal(res.statusCode, 400);
      assert.equal(fake.writes.length, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("4. Baja de un acompañante", () => {
    it("cancela solo a ese acompañante, libera su asiento y su lugar, y descuenta un lugar del total", async () => {
      const fake = scenario({ ledger: [{ amount: 900 }], status: "CONFIRMED" });
      const titularBefore = structuredClone(fake.passenger(BOOKING, TITULAR));
      const companion2Before = structuredClone(fake.passenger(BOOKING, COMPANION_2));
      const ledgerBefore = structuredClone(fake.paymentsOf(BOOKING));
      const other = snapshotOtherBooking(fake);

      const res = await dropPassenger(COMPANION_1);

      assert.equal(res.statusCode, 200);
      const dropped = fake.passenger(BOOKING, COMPANION_1);
      assert.equal(dropped.status, "CANCELLED");
      assert.equal(dropped.seatLabel, null);
      // Los demás pasajeros, intactos.
      assert.deepEqual(fake.passenger(BOOKING, TITULAR), titularBefore);
      assert.deepEqual(fake.passenger(BOOKING, COMPANION_2), companion2Before);
      // Dinero: total − un lugar; lo abonado y el libro no cambian.
      assert.equal(fake.booking(BOOKING).totalPrice, 2000);
      assert.equal(fake.booking(BOOKING).amountPaid, 900);
      assert.deepEqual(fake.paymentsOf(BOOKING), ledgerBefore);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PARTIAL");
      // Grupo y cupo: un lugar menos; el anticipo baja a $600 y sigue confirmada.
      assert.equal(fake.token(BOOKING).numberPassengers, 2);
      assert.equal(occupiedSeats(fake), 3);
      assert.equal(fake.booking(BOOKING).status, "CONFIRMED");
      assert.deepEqual(snapshotOtherBooking(fake), other);
      assert.deepEqual(res.json().data.financialSummary, {
        previousTotal: 3000,
        newTotal: 2000,
        amountPaid: 900,
        retainedAmount: 0, // lo abonado ($900) cabe en el nuevo total: se absorbe en el saldo
        hasSurplus: false,
        surplusAmount: 0,
      });
    });

    it("con penalización: se descuenta el lugar menos lo retenido", async () => {
      const fake = scenario();
      await dropPassenger(COMPANION_1, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 2200);
    });

    it("con un lugar aún sin registrar descuenta el precio de UN lugar (antes total ÷ activos = $1,500)", async () => {
      // 3 lugares apartados, solo titular + 1 acompañante registrados.
      const fake = scenario({ companions: [COMPANION_1] });
      const res = await dropPassenger(COMPANION_1);
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 2000);
      assert.equal(fake.token(BOOKING).numberPassengers, 2);
    });

    it("penalización mayor al precio de un lugar → 400 sin escribir", async () => {
      const fake = scenario();
      const res = await dropPassenger(COMPANION_1, 1001);
      assert.equal(res.statusCode, 400);
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.passenger(BOOKING, COMPANION_1).status, "ACTIVE");
    });

    it("el titular no se da de baja por aquí → 409 sin escribir", async () => {
      const fake = scenario();
      const res = await dropPassenger(TITULAR);
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /transfiere la titularidad o cancela la reserva completa/);
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.passenger(BOOKING, TITULAR).status, "ACTIVE");
    });

    it("usa el precio PACTADO aunque el total incluya una retención previa (no la reparte)", async () => {
      const fake = scenario();
      await dropPassenger(COMPANION_1, 200); // $3,000 → $2,200 ($1,000 × 2 + $200 retenidos)
      await dropPassenger(COMPANION_2);
      // $1,000 × 1 + $200. Con total ÷ lugares daba $1,100: la retención se "comía" en el precio.
      assert.equal(fake.booking(BOOKING).totalPrice, 1200);
    });

    it("usa el precio pactado aunque el precio del tour haya cambiado después de apartar", async () => {
      const fake = scenario({ tourPrice: 1500 });
      await dropPassenger(COMPANION_1);
      assert.equal(fake.booking(BOOKING).totalPrice, 2000);
    });

    it("reserva anterior sin precio guardado: respaldo total ÷ lugares apartados", async () => {
      const fake = scenario({ unitPrice: null, tourPrice: 1500 });
      await dropPassenger(COMPANION_1);
      assert.equal(fake.booking(BOOKING).totalPrice, 2000);
    });

    it("dar de baja dos veces al mismo acompañante → 409 y no descuenta otra vez", async () => {
      const fake = scenario();
      assert.equal((await dropPassenger(COMPANION_1)).statusCode, 200);
      const writesAfterFirst = fake.writes.length;
      const res = await dropPassenger(COMPANION_1);
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya fue dado de baja/);
      assert.equal(fake.writes.length, writesAfterFirst);
      assert.equal(fake.booking(BOOKING).totalPrice, 2000);
      assert.equal(fake.token(BOOKING).numberPassengers, 2);
    });

    it("dos bajas seguidas: cada una descuenta un lugar ($3,000 → $2,000 → $1,000)", async () => {
      const fake = scenario();
      await dropPassenger(COMPANION_1);
      await dropPassenger(COMPANION_2);
      assert.equal(fake.booking(BOOKING).totalPrice, 1000);
      assert.equal(fake.token(BOOKING).numberPassengers, 1);
      assert.equal(fake.passenger(BOOKING, TITULAR).status, "ACTIVE");
    });

    it("lo abonado supera el nuevo total: el excedente se retiene, saldo $0 y sin saldo a favor", async () => {
      // Decisión del usuario (2026-11-17): $2,500 abonados de $3,000 y baja de un lugar de $1,000.
      const fake = scenario({ ledger: [{ amount: 2500 }] });
      const res = await dropPassenger(COMPANION_1);
      assert.equal(res.statusCode, 200);
      assert.equal(fake.booking(BOOKING).totalPrice, 2500); // no $2,000
      assert.equal(fake.booking(BOOKING).amountPaid, 2500);
      assert.equal(fake.booking(BOOKING).paymentStatus, "PAID");
      assert.deepEqual(res.json().data.financialSummary, {
        previousTotal: 3000,
        newTotal: 2500,
        amountPaid: 2500,
        retainedAmount: 500,
        hasSurplus: false,
        surplusAmount: 0,
      });
      // El lugar sí se libera: el cupo baja aunque el total no baje los $1,000.
      assert.equal(fake.token(BOOKING).numberPassengers, 2);
    });

    it("liquidada ($3,000) y baja de uno: retiene el precio completo del lugar ($1,000)", async () => {
      const fake = scenario({ ledger: [{ amount: 3000 }] });
      const res = await dropPassenger(COMPANION_1);
      assert.equal(fake.booking(BOOKING).totalPrice, 3000);
      assert.equal(res.json().data.financialSummary.retainedAmount, 1000);
    });

    it("tope: la retención automática nunca supera el precio de un lugar (reserva anterior pagada de más)", async () => {
      const fake = scenario({ ledger: [{ amount: 3200 }] }); // posible antes de bloquear sobrepagos
      const res = await dropPassenger(COMPANION_1);
      const summary = res.json().data.financialSummary;
      assert.equal(summary.retainedAmount, 1000);
      assert.equal(fake.booking(BOOKING).totalPrice, 3000);
      assert.equal(summary.surplusAmount, 200);
    });

    it("la retención enviada cuenta dentro del tope: $300 enviados + excedente ≤ $1,000", async () => {
      const fake = scenario({ ledger: [{ amount: 2900 }] });
      const res = await dropPassenger(COMPANION_1, 300);
      // Sin excedente: $2,000 + $300 = $2,300 < $2,900 → se retienen $900 en total.
      assert.equal(res.json().data.financialSummary.retainedAmount, 900);
      assert.equal(fake.booking(BOOKING).totalPrice, 2900);
    });

    it("pasajero inexistente o de otra reserva → 404 sin escribir", async () => {
      const fake = scenario();
      const res = await dropPassenger(OTHER_TITULAR);
      assert.equal(res.statusCode, 404);
      assert.equal(fake.writes.length, 0);
    });

    it("reserva de otra agencia → 404 sin escribir", async () => {
      const fake = scenario();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/bookingPassengers/${BOOKING}/passengers/${COMPANION_1}/cancel`,
        cookies: sessionCookie(app, AGENCY_B, USER_A),
        payload: { penaltyAmount: 0 },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(fake.writes.length, 0);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("derivePaymentStatus (regla única del estado de pago)", () => {
  const cases: [string, Parameters<typeof derivePaymentStatus>[0], string][] = [
    ["sin dinero", { amountPaid: 0, totalPrice: 3000 }, "PENDING"],
    ["total $0 sin dinero (cancelada sin retención)", { amountPaid: 0, totalPrice: 0 }, "PENDING"],
    ["abono parcial", { amountPaid: 500, totalPrice: 3000 }, "PARTIAL"],
    ["liquidada", { amountPaid: 3000, totalPrice: 3000 }, "PAID"],
    ["pagado de más", { amountPaid: 3200, totalPrice: 3000 }, "PAID"],
    ["dinero con total $0", { amountPaid: 500, totalPrice: 0 }, "PAID"],
    ["devuelto a $0", { amountPaid: 0, totalPrice: 0, hasRefund: true }, "REFUNDED"],
    ["devolución parcial", { amountPaid: 600, totalPrice: 0, hasRefund: true }, "PAID"],
    ["importes numeric como texto", { amountPaid: "999.999", totalPrice: "1000.00" }, "PAID"],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name} → ${expected}`, () => assert.equal(derivePaymentStatus(input), expected));
  }
});
