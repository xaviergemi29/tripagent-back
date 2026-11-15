import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// El front muestra todo importe como "$1,000.00 MXN|USD" con la moneda real del tour:
// estas respuestas deben enviarla (antes asumían MXN en pantalla).

const TOUR_ID = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const TRAVELER_ID = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";

function magicToken(status: string, paymentStatus: string) {
  return {
    token: "tok",
    numberPassengers: 2,
    tour: {
      id: TOUR_ID,
      title: "Disney Orlando",
      departureDateTime: "2026-12-20",
      currency: "USD",
      price: 1200,
      depositPerPerson: 300,
      boardingPoints: [],
      agency: { id: AGENCY_A, name: "Viajes Xalapa", phone: "2281234567" },
    },
    booking: {
      id: "booking-1",
      status,
      paymentStatus,
      totalPrice: 2400,
      amountPaid: 0,
      passengers: [
        {
          isTitular: true,
          status: "ACTIVE",
          boardingPoint: null,
          traveler: { fullName: "Ana Torres" },
        },
      ],
      payments: [],
    },
  };
}

describe("Moneda del tour en las respuestas", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  for (const [label, status, paymentStatus, flowState] of [
    ["registro", "AWAITING_REGISTRATION", "PENDING", "PENDING_REGISTRATION"],
    ["instrucciones de pago", "PENDING", "PENDING", "PENDING_PAYMENT"],
  ] as const) {
    it(`Magic Link (${label}): tourInfo.currency`, async () => {
      mock.method(db.query.magicTokens, "findFirst", (async () =>
        magicToken(status, paymentStatus)) as never);

      const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().flowState, flowState);
      assert.equal(res.json().data.tourInfo.currency, "USD");
    });
  }

  it("historial del viajero: moneda por viaje y LTV por divisa (sin mezclar MXN y USD)", async () => {
    mock.method(db.query.travelers, "findFirst", (async () => ({
      id: TRAVELER_ID,
      agencyId: AGENCY_A,
      fullName: "Ana Torres",
    })) as never);
    const row = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      isTitular: true,
      passengerStatus: "ACTIVE",
      bookingStatus: "CONFIRMED",
      tourTitle: "Tour",
      departureDateTime: "2026-10-01",
      destinationType: "NATIONAL",
      ...over,
    });
    mock.method(db, "select", (() =>
      chain([
        row({ amountPaid: 6000, currency: "MXN" }),
        row({ amountPaid: 1500, currency: "USD" }),
        row({ amountPaid: 500, currency: "USD" }),
        row({ amountPaid: 999, currency: "USD", bookingStatus: "CANCELLED" }), // no suma
        row({ amountPaid: 700, currency: "MXN", isTitular: false }), // acompañante: no suma
      ])) as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/travelers/${TRAVELER_ID}/history`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      body.history.map((h: { currency: string }) => h.currency),
      ["MXN", "USD", "USD", "USD", "MXN"],
    );
    assert.deepEqual(body.metrics.lifetimeValueByCurrency, { MXN: 6000, USD: 2000 });
  });

  it("manifiesto: incluye la moneda del tour", async () => {
    mock.method(db.query.tours, "findFirst", (async () => ({
      id: TOUR_ID,
      agencyId: AGENCY_A,
      title: "Disney Orlando",
      departureDateTime: "2026-12-20",
      currency: "USD",
      boardingPoints: [],
    })) as never);
    mock.method(db.query.bookings, "findMany", (async () => []) as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/manifest/${TOUR_ID}/`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.currency, "USD");
  });
});
