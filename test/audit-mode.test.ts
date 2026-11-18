import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";
import { createFakeLedgerDb } from "./fake-ledger-db.js";
import { TourService } from "../src/modules/tours/tours.service.js";

/**
 * Modo Auditoría en la API (OBS-004; regla 9 de `../CLAUDE.md`; decisión del usuario, 2026-11-17).
 * Un tour FINALIZADO o CANCELADO es de solo consulta: toda mutación del operador responde 409 sin
 * escribir. EN CURSO sigue operable. Excepción: reembolsos en un tour CANCELADO (tour-cancellation).
 *
 * La reserva se deja activa también en el tour CANCELADO (defensa en profundidad: al cancelar el tour
 * todas sus reservas se cancelan, pero la API no depende de eso).
 */

const TOUR = randomUUID();
const BOOKING = randomUUID();
const TITULAR = randomUUID();
const COMPANION = randomUUID();

const shiftDays = (days: number) => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const TOUR_STATES = {
  FINALIZADO: { departureDateTime: shiftDays(-10), returnDate: shiftDays(-8), cancelledAt: null },
  CANCELADO: {
    departureDateTime: shiftDays(10),
    returnDate: shiftDays(12),
    cancelledAt: "2026-11-14T10:00:00.000Z",
  },
  "EN CURSO": { departureDateTime: shiftDays(-1), returnDate: shiftDays(1), cancelledAt: null },
} as const;

/** Reserva de 3 lugares ($3,000) con titular y un acompañante registrados y $1,000 abonados. */
function scenario(state: keyof typeof TOUR_STATES) {
  const paymentId = randomUUID();
  const fake = createFakeLedgerDb({
    tours: [
      {
        id: TOUR,
        agencyId: AGENCY_A,
        price: 1000,
        depositPerPerson: 300,
        currency: "MXN",
        maxCapacity: 20,
        staffCapacity: 1,
        brochureUrl: null,
        deletedAt: null,
        ...TOUR_STATES[state],
      },
    ],
    bookings: [
      {
        id: BOOKING,
        agencyId: AGENCY_A,
        tourId: TOUR,
        travelerId: TITULAR,
        status: "CONFIRMED",
        paymentStatus: "PARTIAL",
        totalPrice: 3000,
        unitPrice: 1000,
        amountPaid: 1000,
        deletedAt: null,
      },
    ],
    bookingPassengers: [
      {
        id: randomUUID(),
        bookingId: BOOKING,
        travelerId: TITULAR,
        isTitular: true,
        status: "ACTIVE",
        seatLabel: "1",
        passengerType: "ADULT",
      },
      {
        id: randomUUID(),
        bookingId: BOOKING,
        travelerId: COMPANION,
        isTitular: false,
        status: "ACTIVE",
        seatLabel: null,
        passengerType: "ADULT",
      },
    ],
    magicTokens: [{ id: randomUUID(), bookingId: BOOKING, numberPassengers: 3 }],
    payments: [
      {
        id: paymentId,
        agencyId: AGENCY_A,
        bookingId: BOOKING,
        amount: 1000,
        type: "PAYMENT",
        method: "TRANSFER",
        currency: "MXN",
        referenceInfo: null,
      },
    ],
  });
  return { fake, paymentId };
}

describe("Modo Auditoría en la API (OBS-004)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);

  /** Cada mutación del operador sobre el tour, sus reservas, sus pagos o sus asientos. */
  const mutations = (paymentId: string) =>
    [
      [
        "registrar un abono",
        "POST",
        `/api/payments/${BOOKING}/payments`,
        { amount: 500, method: "CASH", currency: "MXN" },
      ],
      [
        "anular un abono",
        "POST",
        `/api/payments/${BOOKING}/payments/${paymentId}/void`,
        { reason: "Error de captura" },
      ],
      [
        "apartado rápido",
        "POST",
        `/api/bookings/${TOUR}/quick-booking`,
        {
          fullName: "Ana Ruiz",
          whatsapp: "+522281234567",
          whatsappCountry: "MX",
          email: "ana@correo.mx",
          numberPassengers: 1,
        },
      ],
      ["agregar un lugar", "POST", `/api/bookings/${BOOKING}/add-passenger`, { tourId: TOUR }],
      ["liberar un lugar pendiente", "DELETE", `/api/bookings/${BOOKING}/pending-slots`, undefined],
      [
        "dar de baja a un acompañante",
        "PATCH",
        `/api/bookingPassengers/${BOOKING}/passengers/${COMPANION}/cancel`,
        { penaltyAmount: 0 },
      ],
      [
        "cancelar la reserva completa",
        "PATCH",
        `/api/bookings/${BOOKING}/cancel-full`,
        { penaltyAmount: 1000 },
      ],
      [
        "transferir un lugar",
        "PATCH",
        `/api/bookings/${BOOKING}/transfer`,
        {
          passengerId: COMPANION,
          role: "COMPANION",
          fullName: "Luis Pérez",
          whatsapp: "+522287654321",
          whatsappCountry: "MX",
          email: "luis@correo.mx",
          isMinor: false,
        },
      ],
      ["bloquear un asiento", "PATCH", `/api/seats/${TOUR}/seats/5`, { status: "BLOCKED" }],
      ["liberar un asiento", "PATCH", `/api/seats/${TOUR}/seats/1`, { status: "AVAILABLE" }],
      ["editar el tour", "PATCH", `/api/tours/${TOUR}`, { title: "Nuevo título del tour" }],
    ] as const;

  for (const state of ["FINALIZADO", "CANCELADO"] as const) {
    describe(`tour ${state}`, () => {
      for (const [label, method, url, payload] of mutations("PAYMENT_ID")) {
        it(`${label} → 409 sin escribir`, async () => {
          const { fake, paymentId } = scenario(state);
          const res = await app.inject({
            method,
            url: url.replace("PAYMENT_ID", paymentId),
            cookies: cookies(),
            ...(payload ? { payload } : {}),
          });

          assert.equal(res.statusCode, 409, res.body);
          // Un abono en un tour CANCELADO conserva su mensaje: solo admite reembolsos (regla 18).
          assert.match(
            res.json().error,
            state === "CANCELADO" && label === "registrar un abono"
              ? /solo se pueden registrar reembolsos/
              : /solo consulta/,
          );
          assert.equal(fake.writes.length, 0);
        });
      }

      it("cambiar el folleto → 409 sin actualizar la base", async () => {
        const { fake } = scenario(state);
        await assert.rejects(
          TourService.updateBrochureUrl(TOUR, "/uploads/brochures/nuevo.pdf", AGENCY_A),
          /solo consulta/,
        );
        assert.equal(fake.writes.length, 0);
      });
    });
  }

  it("tour FINALIZADO: un reembolso sigue rechazado (solo existen en un tour cancelado)", async () => {
    const { fake } = scenario("FINALIZADO");
    const res = await app.inject({
      method: "POST",
      url: `/api/payments/${BOOKING}/payments`,
      cookies: cookies(),
      payload: { amount: 500, method: "TRANSFER", currency: "MXN", type: "REFUND" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(fake.writes.length, 0);
  });

  describe("tour EN CURSO: sigue operable", () => {
    it("registra un abono de último minuto", async () => {
      const { fake } = scenario("EN CURSO");
      const res = await app.inject({
        method: "POST",
        url: `/api/payments/${BOOKING}/payments`,
        cookies: cookies(),
        payload: { amount: 500, method: "CASH", currency: "MXN" },
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(fake.booking(BOOKING).amountPaid, 1500);
    });

    it("da de baja a un acompañante", async () => {
      const { fake } = scenario("EN CURSO");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/bookingPassengers/${BOOKING}/passengers/${COMPANION}/cancel`,
        cookies: cookies(),
        payload: { penaltyAmount: 0 },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(fake.passenger(BOOKING, COMPANION).status, "CANCELLED");
    });
  });
});
