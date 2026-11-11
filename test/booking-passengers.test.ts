import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { BookingPassengerService } from "../src/modules/booking-passengers/booking-passengers.service.js";
import { BookingService } from "../src/modules/bookings/booking.service.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

const BOOKING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TRAVELER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const financialSummary = {
  previousTotal: 3000,
  newTotal: 1700,
  amountPaid: 1000,
  hasSurplus: false,
  surplusAmount: 0,
};

// Endpoints de pasajeros/cancelación que consume el front (useTourDashboard / useBookings).
describe("Gestión de pasajeros de una reserva: endpoints en uso", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("PATCH /api/bookingPassengers/:bookingId/passengers/:travelerId/cancel → cancelPassenger", async () => {
    const cancel = mock.method(BookingPassengerService, "cancelPassenger", (async () => ({
      message: "Pasajero cancelado exitosamente.",
      freedSeats: 1,
      financialSummary,
    })) as never);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/bookingPassengers/${BOOKING_ID}/passengers/${TRAVELER_ID}/cancel`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { penaltyAmount: 200 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.freedSeats, 1);
    assert.deepEqual(cancel.mock.calls[0]?.arguments, [BOOKING_ID, TRAVELER_ID, 200, AGENCY_A]);
  });

  it("PATCH /api/bookings/:id/cancel-full → BookingService.cancelFullBooking (implementación vigente)", async () => {
    const cancelFull = mock.method(BookingService, "cancelFullBooking", (async () => ({
      message: "Reserva cancelada exitosamente.",
      financialSummary,
    })) as never);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/bookings/${BOOKING_ID}/cancel-full`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { penaltyAmount: 500 },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(cancelFull.mock.calls[0]?.arguments, [BOOKING_ID, 500, AGENCY_A]);
  });

  it("BookingPassengerService solo conserva la lógica con consumidores (cancelPassenger)", () => {
    const methods = Object.getOwnPropertyNames(BookingPassengerService).filter(
      (name) =>
        typeof (BookingPassengerService as unknown as Record<string, unknown>)[name] === "function",
    );
    assert.deepEqual(methods, ["cancelPassenger"]);
  });
});
