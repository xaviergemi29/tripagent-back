import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db } from "../src/db/index.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { AgencySubscriptionService } from "../src/modules/agencies/agency-subscription.service.js";
import {
  PUBLIC_BOOKINGS_PAUSED_MESSAGE,
  SUBSCRIPTION_READ_ONLY_CODE,
  isAgencyReadOnly,
  isSubscriptionReadOnly,
} from "../src/shared/utils/subscription.util.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Modo Solo Lectura por suscripción (feedback del PM, 2026-11-18): con la prueba vencida o el pago
// pendiente la agencia consulta todo, pero ninguna mutación de negocio pasa (402). El bloqueo total
// (401) solo llega cuando TripAgent desactiva la agencia (`agencies.isActive = false`).

const TOUR_ID = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const NOW = new Date("2026-11-18T18:00:00Z");
const EXPIRED_TRIAL = {
  subscriptionStatus: "trialing",
  trialEndsAt: "2026-11-10T00:00:00Z",
  createdAt: "2026-10-11T00:00:00Z",
};

describe("Regla del Modo Solo Lectura (subscription.util)", () => {
  it("active opera; trialing depende del vencimiento; past_due y canceled quedan en solo lectura", () => {
    assert.equal(isSubscriptionReadOnly("active", true), false);
    assert.equal(isSubscriptionReadOnly("trialing", false), false);
    assert.equal(isSubscriptionReadOnly("trialing", true), true);
    assert.equal(isSubscriptionReadOnly("past_due", false), true);
    assert.equal(isSubscriptionReadOnly("canceled", false), true);
  });

  it("usa trialEndsAt o, si falta, 30 días desde el alta", () => {
    assert.equal(isAgencyReadOnly(EXPIRED_TRIAL, NOW), true);
    assert.equal(
      isAgencyReadOnly({ ...EXPIRED_TRIAL, trialEndsAt: "2026-12-01T00:00:00Z" }, NOW),
      false,
    );
    // Alta el 2026-11-01 sin trialEndsAt → vence el 2026-12-01: sigue en prueba.
    assert.equal(
      isAgencyReadOnly(
        { ...EXPIRED_TRIAL, trialEndsAt: null, createdAt: "2026-11-01T00:00:00Z" },
        NOW,
      ),
      false,
    );
  });
});

describe("API en Modo Solo Lectura", () => {
  let app: TestApp;
  const cookies = () => sessionCookie(app, AGENCY_A, USER_A);

  before(async () => {
    app = await createTestApp({ isAgencyReadOnly: async () => true });
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("una mutación de negocio responde 402 con el código, antes de llegar a la ruta", async () => {
    const requests = [
      { method: "POST" as const, url: "/api/tours" },
      { method: "PATCH" as const, url: `/api/tours/${TOUR_ID}` },
      { method: "DELETE" as const, url: `/api/tours/${TOUR_ID}` },
      { method: "POST" as const, url: `/api/bookings/${TOUR_ID}/quick-booking` },
      { method: "POST" as const, url: `/api/payments/${TOUR_ID}/payments` },
      { method: "PATCH" as const, url: `/api/seats/${TOUR_ID}/seats/5` },
      { method: "PATCH" as const, url: "/api/agencies" },
      { method: "PATCH" as const, url: "/api/agencies/policies" },
      { method: "DELETE" as const, url: "/api/agencies/logo" },
    ];
    for (const request of requests) {
      const res = await app.inject({ ...request, cookies: cookies(), payload: {} });
      assert.equal(res.statusCode, 402, `${request.method} ${request.url}`);
      assert.equal(res.json().code, SUBSCRIPTION_READ_ONLY_CODE);
      assert.match(res.json().error, /solo lectura/);
    }
  });

  it("las lecturas siguen abiertas (Suscripción incluida)", async () => {
    const summary = { status: "trialing", trialExpired: true, isReadOnly: true };
    mock.method(AgencySubscriptionService, "getSubscription", async () => summary);

    const res = await app.inject({
      method: "GET",
      url: "/api/agencies/subscription",
      cookies: cookies(),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { data: summary });
  });

  it("cerrar sesión y cambiar la contraseña siguen permitidos", async () => {
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
    assert.equal(logout.statusCode, 200);

    const change = mock.method(AuthService, "changePassword", async () => undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      cookies: cookies(),
      payload: {
        currentPassword: "actual123",
        newPassword: "nueva123",
        confirmPassword: "nueva123",
      },
    });
    assert.notEqual(res.statusCode, 402);
    assert.equal(change.mock.callCount(), 1);
  });

  it("sin sesión sigue siendo 401 (no revela el estado de la suscripción)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tours", payload: {} });
    assert.equal(res.statusCode, 401);
  });
});

describe("Agencia que opera normal", () => {
  it("una mutación no se detiene por la suscripción", async () => {
    const app = await createTestApp({ isAgencyReadOnly: async () => false });
    const res = await app.inject({
      method: "POST",
      url: "/api/tours",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: {},
    });
    assert.notEqual(res.statusCode, 402);
    assert.equal(res.statusCode, 400); // llega a la validación de la ruta
    await app.close();
  });
});

describe("Bloqueo total: agencia desactivada", () => {
  afterEach(() => mock.restoreAll());

  it("isSessionActive es falso si la agencia está desactivada o borrada", async () => {
    const row = (agency: unknown) => (async () => ({ isActive: true, agency })) as never;

    mock.method(db.query.agencyUsers, "findFirst", row({ isActive: true, deletedAt: null }));
    assert.equal(await AuthService.isSessionActive(USER_A, AGENCY_A), true);

    mock.restoreAll();
    mock.method(db.query.agencyUsers, "findFirst", row({ isActive: false, deletedAt: null }));
    assert.equal(await AuthService.isSessionActive(USER_A, AGENCY_A), false);

    mock.restoreAll();
    mock.method(
      db.query.agencyUsers,
      "findFirst",
      row({ isActive: true, deletedAt: "2026-11-18" }),
    );
    assert.equal(await AuthService.isSessionActive(USER_A, AGENCY_A), false);

    mock.restoreAll();
    mock.method(db.query.agencyUsers, "findFirst", row(null));
    assert.equal(await AuthService.isSessionActive(USER_A, AGENCY_A), false);
  });

  it("el login de una agencia desactivada responde como credenciales inválidas", async () => {
    const app = await createTestApp();
    mock.method(bcrypt, "compare", async () => true);
    mock.method(db.query.agencyUsers, "findFirst", (async () => ({
      id: USER_A,
      agencyId: AGENCY_A,
      email: "ana@agencia.mx",
      fullName: "Ana",
      role: "ADMIN",
      passwordHash: "hash",
      agency: { isActive: false, deletedAt: null },
    })) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ana@agencia.mx", password: "secreta123" },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, "Credenciales inválidas");
    await app.close();
  });
});

describe("Rutas públicas de una agencia en solo lectura", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const tourRow = {
    id: TOUR_ID,
    agencyId: AGENCY_A,
    title: "Huasteca",
    currency: "MXN",
    transportModality: "TRANSPORT_INCLUDED",
    price: 1500,
    depositPerPerson: 500,
    departureDateTime: "2026-12-20",
    returnDate: "2026-12-21",
    brochureUrl: null,
    boardingPoints: [],
    maxCapacity: 20,
    staffCapacity: 0,
    cancelledAt: null,
    agency: { name: "Agencia", phone: "+522281234567", logoPath: null, ...EXPIRED_TRIAL },
  };

  it("el folleto se sigue viendo, sin pre-reservas y sin exponer la suscripción", async () => {
    mock.method(db.query.tours, "findFirst", (async () => tourRow) as never);
    mock.method(db.query.bookings, "findMany", (async () => []) as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/tour-brochure/public/tours/${TOUR_ID}`,
    });

    assert.equal(res.statusCode, 200);
    const { availability, agency } = res.json().data ?? res.json();
    assert.equal(availability.acceptsOnlineBookings, false);
    assert.equal(availability.isBookable, false);
    assert.equal(availability.hasDeparted, false);
    assert.deepEqual(Object.keys(agency).sort(), ["logoPath", "name", "phone"]);
    assert.doesNotMatch(res.body, /trialing|subscriptionStatus|trialEndsAt/);
  });

  it("la pre-reserva responde 409 sin escribir", async () => {
    let writes = 0;
    const tx = {
      query: { tours: { findFirst: async () => tourRow } },
      insert: () => {
        writes += 1;
        throw new Error("no debe escribir");
      },
      select: () => {
        writes += 1;
        throw new Error("no debe bloquear cupo");
      },
    };
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/public/pre-booking",
      payload: {
        tourId: TOUR_ID,
        fullName: "Mariana Ruiz",
        whatsapp: "2299887766",
        numberPassengers: 2,
      },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, PUBLIC_BOOKINGS_PAUSED_MESSAGE);
    assert.equal(res.json().code, "BOOKINGS_CLOSED");
    assert.equal(writes, 0);
  });
});

describe("GET /agencies/subscription incluye isReadOnly", () => {
  afterEach(() => mock.restoreAll());

  it("prueba vencida → isReadOnly true; plan activo → false", async () => {
    mock.method(AgencySubscriptionService, "countActiveTours", async () => 1);
    mock.method(AgencySubscriptionService, "countTravelers", async () => 2);
    const billing = { spei: null, stripePaymentLink: null, whatsappSupportNumber: null };

    mock.method(db.query.agencies, "findFirst", async () => ({
      id: AGENCY_A,
      name: "Bruji Tours",
      ...EXPIRED_TRIAL,
    }));
    const expired = await AgencySubscriptionService.getSubscription(AGENCY_A, NOW, billing);
    assert.equal(expired?.isReadOnly, true);

    mock.restoreAll();
    mock.method(AgencySubscriptionService, "countActiveTours", async () => 1);
    mock.method(AgencySubscriptionService, "countTravelers", async () => 2);
    mock.method(db.query.agencies, "findFirst", async () => ({
      id: AGENCY_A,
      name: "Bruji Tours",
      ...EXPIRED_TRIAL,
      subscriptionStatus: "active",
    }));
    const active = await AgencySubscriptionService.getSubscription(AGENCY_A, NOW, billing);
    assert.equal(active?.isReadOnly, false);
  });
});
