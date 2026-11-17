import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

const TOUR_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";

const tourWithDeposit = (depositPerPerson: number) => ({
  id: TOUR_ID,
  agencyId: AGENCY_A,
  title: "Huasteca Potosina",
  price: 1000,
  depositPerPerson,
  maxCapacity: 20,
  staffCapacity: 2,
  currency: "MXN",
  transportModality: "TRANSPORT_INCLUDED",
  departureDateTime: "2026-12-15",
  vehicle: null,
  agency: { name: "Viajes Xalapa" },
});

/** Reserva de 2 lugares ($2,000) con lo pagado indicado. */
const bookingPaid = (id: string, amountPaid: number) => ({
  id,
  status: "PENDING",
  paymentStatus: amountPaid > 0 ? "PARTIAL" : "PENDING",
  totalPrice: 2000,
  amountPaid,
  createdAt: "2026-11-10T15:00:00.000Z",
  magicToken: { numberPassengers: 2, token: `tok-${id}` },
  payments: [],
  passengers: [
    {
      isTitular: true,
      status: "ACTIVE",
      seatLabel: null,
      boardingPoint: null,
      traveler: {
        id: `trav-${id}`,
        fullName: `Titular ${id}`,
        whatsappPhone: "2281234567",
        emergencyContactPhone: "2287654321",
      },
    },
  ],
});

/**
 * El dashboard consulta dos veces las reservas: primero las activas y después las canceladas (para
 * los reembolsos). Este mock responde en ese orden.
 */
function mockBookings(active: unknown[], cancelled: unknown[] = []) {
  let call = 0;
  mock.method(db.query.bookings, "findMany", (async () =>
    call++ === 0 ? active : cancelled) as never);
}

describe("Centro de Control: derecho a asiento por anticipo cubierto", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const getDashboard = () =>
    app.inject({
      method: "GET",
      url: `/api/dashboards/${TOUR_ID}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

  it("anticipo $500/persona × 2: $50 no da derecho; $1,000 sí; métrica logística cuenta solo al segundo", async () => {
    mock.method(db.query.tours, "findFirst", (async () => tourWithDeposit(500)) as never);
    mockBookings([bookingPaid("b1", 50), bookingPaid("b2", 1000)]);

    const res = await getDashboard();
    const [low, covered] = res.json().travelers;

    assert.equal(res.statusCode, 200);
    assert.equal(low.requiredDeposit, 1000);
    assert.equal(low.hasSeatRight, false);
    assert.equal(covered.hasSeatRight, true);
    assert.equal(res.json().metrics.logistics.total, 2); // solo el grupo b2 (2 lugares)
    // Fecha del apartado para la antigüedad "Apartado hace N h sin pago" (regla 13).
    assert.equal(low.bookedAt, "2026-11-10T15:00:00.000Z");
  });

  it("anticipo $0 (regla literal): derecho a asiento sin pagos", async () => {
    mock.method(db.query.tours, "findFirst", (async () => tourWithDeposit(0)) as never);
    mockBookings([bookingPaid("b1", 0)]);

    const res = await getDashboard();

    assert.equal(res.json().travelers[0].hasSeatRight, true);
  });

  it("ocupación = personas de todas las reservas activas (pagadas o no) / capacidad vendible", async () => {
    mock.method(db.query.tours, "findFirst", (async () => tourWithDeposit(500)) as never);
    mockBookings([
      { ...bookingPaid("b1", 0), status: "AWAITING_REGISTRATION" }, // sin pago ni formulario
      bookingPaid("b2", 1000),
    ]);

    const { metrics } = (await getDashboard()).json();

    assert.deepEqual(metrics.occupancy, { max: 18, current: 4 }); // 20 − 2 de staff; 2 + 2
    assert.equal(metrics.revenue.projected, 18 * 1000);
  });

  it("comprobante del operador: cada pasajero trae su punto de abordaje resuelto (ubicación y hora)", async () => {
    const tour = {
      ...tourWithDeposit(0),
      boardingPoints: [{ id: "bp-1", location: "Plaza", time: "06:00" }],
    };
    const booking = bookingPaid("b1", 0);
    booking.passengers[0]!.boardingPoint = "bp-1" as never;
    booking.passengers.push({
      isTitular: false,
      status: "ACTIVE",
      seatLabel: null,
      boardingPoint: "Desconocido" as never,
      traveler: {
        id: "trav-c1",
        fullName: "Acompañante",
        whatsappPhone: "2281112222",
        emergencyContactPhone: "2283334444",
      },
    });
    mock.method(db.query.tours, "findFirst", (async () => tour) as never);
    mockBookings([booking]);

    const [titular] = (await getDashboard()).json().travelers;

    assert.deepEqual(titular.boardingPointDetails, { location: "Plaza", time: "06:00" });
    assert.equal(titular.companions[0].boardingPointDetails, null);
  });
});

describe("Centro de Control: tour cancelado y reembolsos (decisión del PM, 2026-11-14)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const getDashboard = () =>
    app.inject({
      method: "GET",
      url: `/api/dashboards/${TOUR_ID}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

  const cancelledBooking = (
    id: string,
    amountPaid: number,
    payments: { type: string; amount: number; referenceInfo?: string | null }[],
    totalPrice = 0,
  ) => ({
    ...bookingPaid(id, amountPaid),
    status: "CANCELLED",
    totalPrice,
    traveler: { id: `trav-${id}`, fullName: `Titular ${id}`, whatsappPhone: "2281234567" },
    payments: payments.map((payment, i) => ({
      id: `pay-${id}-${i}`,
      method: "TRANSFER",
      createdAt: "2026-11-10T15:00:00.000Z",
      referenceInfo: null,
      collectedCurrency: null,
      collectedAmount: null,
      exchangeRate: null,
      createdByUser: null,
      ...payment,
    })),
  });

  it("tour cancelado: trae el motivo y la nota interna, y la lista de reembolsos", async () => {
    mock.method(db.query.tours, "findFirst", (async () => ({
      ...tourWithDeposit(500),
      cancelledAt: "2026-11-14T10:00:00.000Z",
      cancellationReason: "WEATHER",
      cancellationNote: "Pronóstico de tormenta",
    })) as never);
    mockBookings(
      [],
      [
        // Pagó $2,000 y aún no se le devuelve nada.
        cancelledBooking("b1", 2000, [{ type: "PAYMENT", amount: 2000 }]),
        // Pagó $1,500 y ya se le devolvió todo (SPEI con referencia, no es una anulación).
        cancelledBooking("b2", 0, [
          { type: "PAYMENT", amount: 1500 },
          { type: "REFUND", amount: -1500, referenceInfo: "SPEI devolución por clima Ref: 98123" },
        ]),
        // Apartó sin pagar: no aparece en reembolsos.
        cancelledBooking("b3", 0, []),
      ],
    );

    const body = (await getDashboard()).json();

    assert.equal(body.temporalStatus, "CANCELADO");
    assert.deepEqual(body.cancellation, {
      cancelledAt: "2026-11-14T10:00:00.000Z",
      reason: "WEATHER",
      note: "Pronóstico de tormenta",
    });
    assert.deepEqual(
      body.refunds.map((r: Record<string, unknown>) => [
        r.fullName,
        r.paidAmount,
        r.refundedAmount,
        r.refundableAmount,
        r.refundStatus,
      ]),
      [
        ["Titular b1", 2000, 0, 2000, "PENDING"],
        ["Titular b2", 1500, 1500, 0, "COMPLETED"],
      ],
    );
    assert.equal(body.travelers.length, 0);
  });

  it("cancelación del cliente (tour no cancelado): no hay reembolsos, la agencia retiene lo abonado", async () => {
    mock.method(db.query.tours, "findFirst", (async () => tourWithDeposit(500)) as never);
    const findMany = mock.method(db.query.bookings, "findMany", (async () => []) as never);

    const body = (await getDashboard()).json();

    assert.deepEqual(body.refunds, []);
    assert.equal(findMany.mock.callCount(), 1); // ni siquiera consulta las canceladas
  });

  it("una anulación (contra-asiento) no cuenta como devolución al cliente", async () => {
    mock.method(db.query.tours, "findFirst", (async () => ({
      ...tourWithDeposit(500),
      cancelledAt: "2026-11-14T10:00:00.000Z",
      cancellationReason: "WEATHER",
      cancellationNote: null,
    })) as never);
    const voidRef = "Anulación: Error de captura (Ref: 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f)";
    mockBookings(
      [],
      [
        cancelledBooking("b1", 1000, [
          { type: "PAYMENT", amount: 1000 },
          { type: "PAYMENT", amount: 300 },
          { type: "REFUND", amount: -300, referenceInfo: voidRef },
        ]),
      ],
    );

    const [refund] = (await getDashboard()).json().refunds;

    assert.equal(refund.paidAmount, 1000);
    assert.equal(refund.refundedAmount, 0);
    assert.equal(refund.refundableAmount, 1000);
  });
});
