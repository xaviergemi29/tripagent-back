import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { Agency } from "../src/modules/agencies/agency.service.js";
import {
  AGENCY_A,
  USER_A,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

/** Fila completa de `agencies`, incluidas las columnas bancarias heredadas (solo respaldo). */
const fullAgencyRow = (id: string) => ({
  id,
  name: "Agencia Prueba",
  phone: "+525512345678",
  phoneCountry: "MX",
  email: "privado@agencia.test",
  address: "Calle 1",
  logoPath: null,
  privacyNoticeUrl: null,
  policies: null,
  subscriptionStatus: "trialing",
  trialEndsAt: null,
  subscriptionPeriodEndsAt: null,
  subscriptionCanceledAt: null,
  subscriptionCancellationReason: null,
  subscriptionCancellationComment: null,
  isActive: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  bankName: "Banco Heredado",
  bankAccountHolder: "Titular Heredado",
  clabeNumber: "999999999999999999",
  cardNumber: "4111111111111111",
});

const ACCOUNT = {
  id: "c0c0c0c0-0000-4000-8000-000000000001",
  bankName: "BBVA",
  accountHolder: "Agencia Prueba SA",
  clabeNumber: "012180015549201823",
  cardNumber: null,
  position: 1,
};

describe("GET /api/agencies (datos privados de la agencia de la sesión)", () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("devuelve la agencia de la sesión con bankAccounts y sin las columnas bancarias heredadas", async () => {
    // Simula la consulta relacional: aplica la lista blanca `columns` y agrega `bankAccounts`.
    const find = mock.method(db.query.agencies, "findFirst", (async (config: {
      where: SQL;
      columns: Record<string, boolean>;
      with: { bankAccounts: unknown };
    }) => {
      const row: Record<string, unknown> = fullAgencyRow(AGENCY_A);
      if (!rowMatches(config.where, row)) return undefined;
      const projected = Object.fromEntries(
        Object.keys(config.columns).map((key) => [key, row[key]]),
      );
      return config.with.bankAccounts ? { ...projected, bankAccounts: [ACCOUNT] } : projected;
    }) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/agencies",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(find.mock.callCount(), 1);
    const { data } = res.json();
    assert.equal(data.id, AGENCY_A);
    assert.equal(data.name, "Agencia Prueba");
    assert.deepEqual(data.bankAccounts, [ACCOUNT]);
    for (const key of ["bankName", "bankAccountHolder", "clabeNumber", "cardNumber"]) {
      assert.equal(key in data, false, `${key} no debe salir en GET /agencies`);
    }
    assert.ok(!res.body.includes("999999999999999999"));
    assert.ok(!res.body.includes("4111111111111111"));
  });
});

describe("PATCH /api/agencies/policies (políticas generales de la agencia)", () => {
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
      url: "/api/agencies/policies",
      payload: payload as object,
      ...(withSession ? { cookies: sessionCookie(app, AGENCY_A, USER_A) } : {}),
    });

  it("sin sesión responde 401 y no escribe", async () => {
    const update = mock.method(Agency, "updatePolicies", async () => ({ policies: null }));
    const res = await patch({ policies: "Sin reembolsos" }, false);
    assert.equal(res.statusCode, 401);
    assert.equal(update.mock.callCount(), 0);
  });

  it("guarda el texto recortado en la agencia de la sesión", async () => {
    const update = mock.method(
      Agency,
      "updatePolicies",
      async (_id: string, policies: string | null) => ({
        policies,
      }),
    );
    const res = await patch({
      policies: "  Cancelación sin costo hasta 7 días antes.\nNo se reembolsa el anticipo.  ",
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(update.mock.calls[0]?.arguments, [
      AGENCY_A,
      "Cancelación sin costo hasta 7 días antes.\nNo se reembolsa el anticipo.",
    ]);
    assert.match(res.json().data.policies, /^Cancelación/);
  });

  it("texto vacío las quita (null)", async () => {
    const update = mock.method(Agency, "updatePolicies", async () => ({ policies: null }));
    const res = await patch({ policies: "   " });
    assert.equal(res.statusCode, 200);
    assert.equal(update.mock.calls[0]?.arguments[1], null);
  });

  it("más de 5000 caracteres → 400 sin escribir", async () => {
    const update = mock.method(Agency, "updatePolicies", async () => ({ policies: null }));
    const res = await patch({ policies: "x".repeat(5001) });
    assert.equal(res.statusCode, 400);
    assert.equal(update.mock.callCount(), 0);
  });
});

describe("PATCH /api/agencies (datos de la agencia)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  // Lo que envía `AgencyTab`: solo los campos del perfil (las cuentas tienen sus endpoints).
  const formBody = {
    name: "Agencia Prueba",
    phone: "5512345678",
    email: "privado@agencia.test",
    address: "Calle 1",
  };
  const patch = (payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: "/api/agencies",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload,
    });

  it("sin CLABE ya no responde 400: el perfil se guarda sin datos bancarios", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch(formBody);

    assert.equal(res.statusCode, 200);
    assert.equal(update.mock.calls[0]!.arguments[0], AGENCY_A);
  });

  it("descarta los campos bancarios del cuerpo (aunque vengan inválidos)", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch({
      ...formBody,
      bankName: "Banco",
      bankAccountHolder: "Titular",
      clabeNumber: "123",
      cardNumber: "4111",
    });

    assert.equal(res.statusCode, 200);
    const body = update.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.deepEqual(
      ["bankName", "bankAccountHolder", "clabeNumber", "cardNumber"].filter((key) => key in body),
      [],
    );
  });

  it("guardar la configuración no toca la suscripción (ni la regresa a prueba ni la reactiva)", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch(formBody);

    assert.equal(res.statusCode, 200);
    const body = update.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.equal("subscriptionStatus" in body, false);
    assert.equal("isActive" in body, false);
    assert.equal("trialEndsAt" in body, false);
  });

  it("un operador no puede activar su suscripción ni extender su prueba desde la API", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch({
      ...formBody,
      subscriptionStatus: "active",
      isActive: false,
      trialEndsAt: "2030-01-01T00:00:00.000Z",
    });

    assert.equal(res.statusCode, 200);
    const body = update.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.deepEqual(
      ["subscriptionStatus", "isActive", "trialEndsAt"].filter((key) => key in body),
      [],
    );
  });

  it("agencia sin dirección (address null) también puede guardar", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch({ ...formBody, address: null });

    assert.equal(res.statusCode, 200);
    assert.equal((update.mock.calls[0]!.arguments[1] as { address: unknown }).address, null);
  });

  it("el UPDATE solo escribe columnas del perfil y no devuelve las bancarias heredadas", async () => {
    const sets: Record<string, unknown>[] = [];
    let returningKeys: string[] = [];
    mock.method(db, "update", (() => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return {
          where: () => ({
            returning: (fields: Record<string, unknown>) => {
              returningKeys = Object.keys(fields);
              return Promise.resolve([{ id: AGENCY_A }]);
            },
          }),
        };
      },
    })) as never);

    const res = await patch({ ...formBody, clabeNumber: "012345678901234567" });

    assert.equal(res.statusCode, 200);
    for (const key of ["bankName", "bankAccountHolder", "clabeNumber", "cardNumber"]) {
      assert.equal(key in sets[0]!, false, `${key} no se escribe`);
      assert.equal(returningKeys.includes(key), false, `${key} no se devuelve`);
    }
  });
});
