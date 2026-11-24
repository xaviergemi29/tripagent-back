import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AgencySubscriptionService } from "../src/modules/agencies/agency-subscription.service.js";
import {
  endOfCurrentMonthInMexico,
  isAgencyReadOnly,
  isSubscriptionReadOnly,
  resolveSubscriptionPeriodEnd,
} from "../src/shared/utils/subscription.util.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

/**
 * Baja programada de la suscripción con cobro por transferencia (2026-11-23): la agencia conserva el
 * acceso completo hasta la fecha de corte y después pasa a Modo Solo Lectura, sin borrar datos.
 */

const NOW = new Date("2026-11-23T18:00:00Z"); // 23 de noviembre, 12:00 CDMX

describe("Reglas de la baja programada (subscription.util)", () => {
  it("el corte por defecto es el último instante del mes en curso en CDMX", () => {
    assert.equal(endOfCurrentMonthInMexico(NOW), "2026-12-01T05:59:59.999Z");
    // 31 de diciembre, 23:00 CDMX (ya 1 de enero en UTC): sigue siendo diciembre en México.
    assert.equal(
      endOfCurrentMonthInMexico(new Date("2027-01-01T05:00:00Z")),
      "2027-01-01T05:59:59.999Z",
    );
    // Febrero de un año no bisiesto.
    assert.equal(
      endOfCurrentMonthInMexico(new Date("2027-02-10T18:00:00Z")),
      "2027-03-01T05:59:59.999Z",
    );
  });

  it("con fecha de fin de periodo registrada se respeta", () => {
    assert.equal(
      resolveSubscriptionPeriodEnd("2026-12-15 05:59:59+00", NOW),
      "2026-12-15T05:59:59.000Z",
    );
    assert.equal(resolveSubscriptionPeriodEnd(null, NOW), "2026-12-01T05:59:59.999Z");
  });

  it("cancel_scheduled opera hasta la fecha de corte y después queda en solo lectura", () => {
    assert.equal(isSubscriptionReadOnly("cancel_scheduled", true, false), false);
    assert.equal(isSubscriptionReadOnly("cancel_scheduled", true, true), true);
    // Los demás estados no cambian.
    assert.equal(isSubscriptionReadOnly("active", true, true), false);
    assert.equal(isSubscriptionReadOnly("past_due", false), true);

    const agency = {
      subscriptionStatus: "cancel_scheduled",
      trialEndsAt: "2026-10-01T00:00:00Z",
      createdAt: "2026-09-01T00:00:00Z",
      subscriptionPeriodEndsAt: "2026-12-01T05:59:59.999Z",
    };
    assert.equal(isAgencyReadOnly(agency, NOW), false);
    assert.equal(isAgencyReadOnly(agency, new Date("2026-12-01T06:00:00Z")), true);
  });
});

/** Transacción falsa: la lectura con candado devuelve `row` y se guardan los `set` del UPDATE. */
function fakeTransaction(row: Record<string, unknown> | undefined) {
  const updates: Record<string, unknown>[] = [];
  const tx = {
    select: () => chain(row ? [row] : []),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return chain(undefined);
      },
    }),
  };
  mock.method(db, "transaction", async (fn: (t: unknown) => unknown) => fn(tx));
  return updates;
}

describe("AgencySubscriptionService.cancelSubscription / reactivateSubscription", () => {
  afterEach(() => mock.restoreAll());

  it("programa la baja con el fin del mes en curso si no hay fecha registrada", async () => {
    const updates = fakeTransaction({
      name: "Bruji Tours",
      subscriptionStatus: "active",
      subscriptionPeriodEndsAt: null,
    });
    const result = await AgencySubscriptionService.cancelSubscription(
      AGENCY_A,
      { reason: "LOW_SEASON", comments: "  Volvemos en marzo  " },
      NOW,
    );

    assert.deepEqual(result, {
      agencyName: "Bruji Tours",
      status: "cancel_scheduled",
      currentPeriodEndsAt: "2026-12-01T05:59:59.999Z",
      canceledAt: NOW.toISOString(),
      reason: "LOW_SEASON",
      comment: "Volvemos en marzo",
    });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.subscriptionStatus, "cancel_scheduled");
    assert.equal(updates[0]!.subscriptionPeriodEndsAt, "2026-12-01T05:59:59.999Z");
    assert.equal(updates[0]!.subscriptionCancellationReason, "LOW_SEASON");
    // No toca el acceso de la agencia ni borra datos.
    assert.equal("isActive" in updates[0]!, false);
    assert.equal("deletedAt" in updates[0]!, false);
  });

  it("respeta la fecha de fin de periodo registrada", async () => {
    fakeTransaction({
      name: "Bruji Tours",
      subscriptionStatus: "active",
      subscriptionPeriodEndsAt: "2026-12-15 05:59:59+00",
    });
    const result = await AgencySubscriptionService.cancelSubscription(
      AGENCY_A,
      { reason: "PRICE" },
      NOW,
    );
    assert.equal(result.currentPeriodEndsAt, "2026-12-15T05:59:59.000Z");
    assert.equal(result.comment, null);
  });

  it("409 si ya hay una baja programada o si el plan no está activo, sin escribir", async () => {
    for (const status of ["cancel_scheduled", "trialing", "past_due", "canceled"]) {
      const updates = fakeTransaction({
        name: "Bruji Tours",
        subscriptionStatus: status,
        subscriptionPeriodEndsAt: null,
      });
      await assert.rejects(
        AgencySubscriptionService.cancelSubscription(AGENCY_A, { reason: "OTHER" }, NOW),
        (error: Error) => error.name === "ConflictError",
        status,
      );
      assert.equal(updates.length, 0, status);
      mock.restoreAll();
    }
  });

  it("reactivar antes del corte vuelve a active y borra la baja", async () => {
    const updates = fakeTransaction({
      name: "Bruji Tours",
      subscriptionStatus: "cancel_scheduled",
      subscriptionPeriodEndsAt: "2026-12-01T05:59:59.999Z",
    });
    const result = await AgencySubscriptionService.reactivateSubscription(AGENCY_A, NOW);
    assert.equal(result.status, "active");
    assert.deepEqual(
      {
        status: updates[0]!.subscriptionStatus,
        canceledAt: updates[0]!.subscriptionCanceledAt,
        reason: updates[0]!.subscriptionCancellationReason,
        comment: updates[0]!.subscriptionCancellationComment,
      },
      { status: "active", canceledAt: null, reason: null, comment: null },
    );
  });

  it("reactivar después del corte o sin baja programada → 409", async () => {
    fakeTransaction({
      name: "Bruji Tours",
      subscriptionStatus: "cancel_scheduled",
      subscriptionPeriodEndsAt: "2026-11-01T05:59:59.999Z",
    });
    await assert.rejects(
      AgencySubscriptionService.reactivateSubscription(AGENCY_A, NOW),
      /La fecha de corte ya pasó/,
    );
    mock.restoreAll();
    fakeTransaction({ name: "X", subscriptionStatus: "active", subscriptionPeriodEndsAt: null });
    await assert.rejects(
      AgencySubscriptionService.reactivateSubscription(AGENCY_A, NOW),
      /no tiene una cancelación programada/,
    );
  });
});

describe("POST /api/agencies/subscription/cancel y /reactivate", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const salesCookie = () => ({
    token: app.jwt.sign({ id: USER_A, agencyId: AGENCY_A, role: "SALES" as const }),
  });

  it("sin sesión responde 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/subscription/cancel",
      payload: { reason: "PRICE" },
    });
    assert.equal(res.statusCode, 401);
  });

  it("un usuario que no es ADMIN recibe 403 y no se cancela nada", async () => {
    const cancel = mock.method(AgencySubscriptionService, "cancelSubscription", async () => {
      throw new Error("no debe llamarse");
    });
    for (const url of [
      "/api/agencies/subscription/cancel",
      "/api/agencies/subscription/reactivate",
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        cookies: salesCookie(),
        payload: { reason: "PRICE" },
      });
      assert.equal(res.statusCode, 403, url);
      assert.match(res.json().error, /Solo el administrador/);
    }
    assert.equal(cancel.mock.callCount(), 0);
  });

  it("ADMIN programa la baja con la agencia de la sesión y responde la fecha de corte", async () => {
    const cancel = mock.method(AgencySubscriptionService, "cancelSubscription", async () => ({
      agencyName: "Bruji Tours",
      status: "cancel_scheduled" as const,
      currentPeriodEndsAt: "2026-12-01T05:59:59.999Z",
      canceledAt: NOW.toISOString(),
      reason: "MISSING_FEATURES" as const,
      comment: null,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/subscription/cancel",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { reason: "MISSING_FEATURES", agencyId: "otra" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(cancel.mock.calls[0]!.arguments[0], AGENCY_A);
    assert.deepEqual(res.json().data, {
      status: "cancel_scheduled",
      currentPeriodEndsAt: "2026-12-01T05:59:59.999Z",
      canceledAt: NOW.toISOString(),
      reason: "MISSING_FEATURES",
      comment: null,
    });
  });

  it("400 con un motivo inválido o un comentario de más de 500 caracteres", async () => {
    for (const payload of [
      { reason: "ME_ABURRI" },
      { reason: "OTHER", comments: "x".repeat(501) },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/agencies/subscription/cancel",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload,
      });
      assert.equal(res.statusCode, 400);
    }
  });

  it("ADMIN reactiva su suscripción", async () => {
    mock.method(AgencySubscriptionService, "reactivateSubscription", async () => ({
      agencyName: "Bruji Tours",
      status: "active" as const,
      currentPeriodEndsAt: "2026-12-01T05:59:59.999Z",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/subscription/reactivate",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.status, "active");
  });

  it("GET /subscription expone la fecha de corte y la baja programada", async () => {
    mock.method(db.query.agencies, "findFirst", async () => ({
      id: AGENCY_A,
      name: "Bruji Tours",
      subscriptionStatus: "cancel_scheduled",
      trialEndsAt: "2026-10-01T00:00:00Z",
      createdAt: "2026-09-01T00:00:00Z",
      subscriptionPeriodEndsAt: "2026-12-01T05:59:59.999Z",
      subscriptionCanceledAt: NOW.toISOString(),
      subscriptionCancellationReason: "PRICE",
      subscriptionCancellationComment: null,
    }));
    mock.method(AgencySubscriptionService, "countActiveTours", async () => 0);
    mock.method(AgencySubscriptionService, "countTravelers", async () => 0);

    const summary = await AgencySubscriptionService.getSubscription(AGENCY_A, NOW, {
      spei: null,
      stripePaymentLink: null,
      whatsappSupportNumber: null,
    });
    assert.equal(summary!.status, "cancel_scheduled");
    assert.equal(summary!.isReadOnly, false);
    assert.equal(summary!.currentPeriodEndsAt, "2026-12-01T05:59:59.999Z");
    assert.deepEqual(summary!.cancellation, {
      canceledAt: NOW.toISOString(),
      reason: "PRICE",
      comment: null,
    });

    const afterCutoff = await AgencySubscriptionService.getSubscription(
      AGENCY_A,
      new Date("2026-12-02T00:00:00Z"),
      { spei: null, stripePaymentLink: null, whatsappSupportNumber: null },
    );
    assert.equal(afterCutoff!.isReadOnly, true);
  });
});
