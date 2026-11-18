import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Agency } from "../src/modules/agencies/agency.service.js";
import { createTourBodySchema } from "../src/modules/tours/tours.schema.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

/**
 * OBS-038 (decisión del PM, 2026-11-17):
 * - un tour necesita al menos un método de cobro activo (`POST /tours`; `PATCH` en tour-lifecycle);
 * - la transferencia cuenta aunque la agencia no tenga CLABE (el Magic Link ofrece WhatsApp);
 * - `PATCH /agencies/bank-account` guarda solo banco, titular y CLABE (modal del formulario de tours).
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
});

describe("PATCH /api/agencies/bank-account (cuenta para transferencias)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const patch = (payload: unknown, withSession = true) =>
    app.inject({
      method: "PATCH",
      url: "/api/agencies/bank-account",
      ...(withSession ? { cookies: sessionCookie(app, AGENCY_A, USER_A) } : {}),
      payload: payload as Record<string, unknown>,
    });

  it("sin sesión → 401 sin escribir", async () => {
    const update = mock.method(Agency, "updateBankAccount", async () => undefined);
    const res = await patch({ clabeNumber: "012345678901234567" }, false);
    assert.equal(res.statusCode, 401);
    assert.equal(update.mock.callCount(), 0);
  });

  it("guarda banco, titular y CLABE de la agencia de la sesión (vacíos → null)", async () => {
    const update = mock.method(Agency, "updateBankAccount", async () => ({
      bankName: null,
      bankAccountHolder: "Viajes Xalapa SA",
      clabeNumber: "012345678901234567",
    }));

    const res = await patch({
      bankName: "  ",
      bankAccountHolder: " Viajes Xalapa SA ",
      clabeNumber: " 012345678901234567 ",
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(update.mock.calls[0]?.arguments[0], AGENCY_A);
    assert.deepEqual(update.mock.calls[0]?.arguments[1], {
      bankName: null,
      bankAccountHolder: "Viajes Xalapa SA",
      clabeNumber: "012345678901234567",
    });
    assert.equal(res.json().data.clabeNumber, "012345678901234567");
  });

  it("CLABE que no tiene 18 dígitos → 400 sin escribir", async () => {
    const update = mock.method(Agency, "updateBankAccount", async () => undefined);
    for (const clabeNumber of ["12345", "01234567890123456A", ""]) {
      const res = await patch({ clabeNumber });
      assert.equal(res.statusCode, 400, clabeNumber);
    }
    assert.equal(update.mock.callCount(), 0);
  });
});
