import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTourBodySchema } from "../src/modules/tours/tours.schema.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

/**
 * OBS-038 (decisión del PM, 2026-11-17):
 * - un tour necesita al menos un método de cobro activo (`POST /tours`; `PATCH` en tour-lifecycle);
 * - la transferencia cuenta aunque la agencia no tenga CLABE (el Magic Link ofrece WhatsApp);
 * - las cuentas bancarias se administran en `/agencies/bank-accounts` (agency-bank-accounts.test.ts).
 */

const tourBody = {
  title: "Huasteca Potosina",
  price: 1000,
  depositPerPerson: 300,
  departureDateTime: "2099-01-10",
  maxCapacity: 20,
  boardingPoints: [
    { id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", location: "Plaza Xalapeña", time: "06:00" },
  ],
};

describe("POST /tours: al menos un método de cobro", () => {
  it("sin ningún método → error con el mismo texto que el formulario", () => {
    const result = createTourBodySchema.safeParse(tourBody);
    assert.equal(result.success, false);
    assert.ok(
      result.error?.issues.some(
        (issue) =>
          issue.message === "Debes habilitar al menos un método de cobro para tus viajeros",
      ),
    );
  });

  it("solo transferencia → válido (la CLABE de la agencia no se exige al guardar el tour)", () => {
    assert.equal(
      createTourBodySchema.safeParse({ ...tourBody, acceptsBankTransfer: true }).success,
      true,
    );
  });

  it("solo efectivo con instrucciones → válido", () => {
    const result = createTourBodySchema.safeParse({
      ...tourBody,
      acceptsCash: true,
      cashInstructions: "Pagar en la oficina del centro",
    });
    assert.equal(result.success, true);
  });

  it("solo tarjeta, sin enlace de pago → válido y un `paymentLink` anterior se descarta", () => {
    const result = createTourBodySchema.safeParse({
      ...tourBody,
      acceptsCreditCard: true,
      paymentLink: "https://pago.example.com/abc",
    });
    assert.equal(result.success, true);
    assert.equal(result.data && "paymentLink" in result.data, false);
  });
});

describe("PATCH /api/agencies/bank-account (eliminado: ahora /agencies/bank-accounts)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });

  it("la ruta singular ya no existe → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agencies/bank-account",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { clabeNumber: "012345678901234567" },
    });
    assert.equal(res.statusCode, 404);
  });
});
