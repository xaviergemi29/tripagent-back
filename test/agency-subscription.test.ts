import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { Agency } from "../src/modules/agencies/agency.service.js";
import { AgencySubscriptionService } from "../src/modules/agencies/agency-subscription.service.js";
import {
  buildSpeiReference,
  computeTrialProgress,
  resolveSubscriptionBillingConfig,
  resolveTrialEndsAt,
} from "../src/shared/utils/subscription.util.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

describe("Reglas de la suscripción (subscription.util)", () => {
  it("consumo de la prueba en días calendario de CDMX", () => {
    // 2026-11-22 12:00 CDMX; vence el 28 a las 17:59 CDMX → quedan 6 días, se consumieron 24.
    const progress = computeTrialProgress(
      "2026-11-28T23:59:59.000Z",
      new Date("2026-11-22T18:00:00Z"),
    );
    assert.deepEqual(progress, {
      trialDaysTotal: 30,
      trialDaysRemaining: 6,
      trialDaysConsumed: 24,
      trialExpired: false,
    });
  });

  it("una prueba vencida queda en 0 días restantes y expired", () => {
    const progress = computeTrialProgress("2026-11-01T00:00:00Z", new Date("2026-11-15T12:00:00Z"));
    assert.equal(progress.trialDaysRemaining, 0);
    assert.equal(progress.trialDaysConsumed, 30);
    assert.equal(progress.trialExpired, true);
  });

  it("sin trialEndsAt, la prueba termina 30 días después del alta", () => {
    assert.equal(resolveTrialEndsAt(null, "2026-11-01 10:00:00+00"), "2026-12-01T10:00:00.000Z");
    assert.equal(
      resolveTrialEndsAt("2026-11-28 23:59:59+00", "2026-11-01 10:00:00+00"),
      "2026-11-28T23:59:59.000Z",
    );
  });

  it("la referencia SPEI usa la primera palabra sin acentos y el final del id", () => {
    assert.equal(
      buildSpeiReference("Bruji Tours", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7492"),
      "BRUJI-7492",
    );
    assert.equal(buildSpeiReference("Ñandú Expediciones", "x-00ab"), "NANDU-00AB");
    assert.equal(buildSpeiReference("123", "x-0001"), "AGENCIA-0001");
  });

  it("los canales de pago sin configurar o inválidos quedan en null", () => {
    assert.deepEqual(resolveSubscriptionBillingConfig({}), {
      spei: null,
      stripePaymentLink: null,
      whatsappSupportNumber: null,
    });
    assert.deepEqual(
      resolveSubscriptionBillingConfig({
        SUBSCRIPTION_SPEI_BANK: "BBVA",
        SUBSCRIPTION_SPEI_BENEFICIARY: "TripAgent",
        SUBSCRIPTION_SPEI_CLABE: "012 180 0155 4920 1823",
        SUBSCRIPTION_STRIPE_PAYMENT_LINK: "http://buy.stripe.com/x",
        SUBSCRIPTION_WHATSAPP_NUMBER: "+52 228 123 4567",
      }),
      {
        spei: { bank: "BBVA", beneficiary: "TripAgent", clabe: "012180015549201823" },
        stripePaymentLink: null, // solo https
        whatsappSupportNumber: "522281234567",
      },
    );
  });
});

describe("GET /api/agencies/subscription", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("sin sesión responde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agencies/subscription" });
    assert.equal(res.statusCode, 401);
  });

  it("devuelve el resumen de la agencia de la sesión", async () => {
    const summary = {
      status: "trialing",
      trialDaysTotal: 30,
      trialDaysRemaining: 6,
      trialDaysConsumed: 24,
      trialExpired: false,
      trialEndsAt: "2026-11-28T23:59:59.000Z",
      priceMxn: 999,
      metrics: { activeToursCount: 12, registeredTravelersCount: 184 },
      speiDetails: null,
      stripePaymentLink: null,
      whatsappSupportNumber: null,
    };
    const get = mock.method(AgencySubscriptionService, "getSubscription", async () => summary);

    const res = await app.inject({
      method: "GET",
      url: "/api/agencies/subscription",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { data: summary });
    assert.equal(get.mock.calls[0]?.arguments[0], AGENCY_A);
  });

  it("getSubscription arma la referencia y los datos de cobro con la agencia de la base", async () => {
    mock.method(db.query.agencies, "findFirst", async () => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7492",
      name: "Bruji Tours",
      subscriptionStatus: "trialing",
      trialEndsAt: null,
      createdAt: "2026-11-01 10:00:00+00",
    }));
    mock.method(AgencySubscriptionService, "countActiveTours", async () => 3);
    mock.method(AgencySubscriptionService, "countTravelers", async () => 40);

    const result = await AgencySubscriptionService.getSubscription(
      AGENCY_A,
      new Date("2026-11-15T18:00:00Z"),
      {
        spei: { bank: "BBVA", beneficiary: "TripAgent", clabe: "012180015549201823" },
        stripePaymentLink: "https://buy.stripe.com/test",
        whatsappSupportNumber: "522281234567",
      },
    );

    assert.ok(result);
    assert.equal(result.trialEndsAt, "2026-12-01T10:00:00.000Z");
    assert.equal(result.trialDaysRemaining, 16);
    assert.deepEqual(result.metrics, { activeToursCount: 3, registeredTravelersCount: 40 });
    assert.equal(result.speiDetails?.reference, "BRUJI-7492");
    assert.equal(result.priceMxn, 999);
  });

  it("agencia inexistente → 404", async () => {
    mock.method(AgencySubscriptionService, "getSubscription", async () => null);
    const res = await app.inject({
      method: "GET",
      url: "/api/agencies/subscription",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });
    assert.equal(res.statusCode, 404);
  });
});

describe("PATCH /api/agencies no toca la suscripción", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("descarta subscriptionStatus, trialEndsAt e isActive del cuerpo", async () => {
    const update = mock.method(Agency, "updateAgency", async () => ({}));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/agencies",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: {
        name: "Bruji Tours",
        phone: "2281234567",
        email: "hola@bruji.mx",
        clabeNumber: "012180015549201823",
        subscriptionStatus: "active",
        trialEndsAt: "2099-01-01T00:00:00Z",
        isActive: false,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = update.mock.calls[0]?.arguments[1] as Record<string, unknown>;
    assert.equal(body.name, "Bruji Tours");
    for (const key of ["subscriptionStatus", "trialEndsAt", "isActive"]) {
      assert.ok(!(key in body), `${key} no debe llegar al servicio`);
    }
  });
});
