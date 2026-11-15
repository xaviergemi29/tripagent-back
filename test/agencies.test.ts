import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Agency } from "../src/modules/agencies/agency.service.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  createTestApp,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

const fullAgencyRow = (id: string) => ({
  id,
  name: "Agencia Prueba",
  phone: "5512345678",
  email: "privado@agencia.test",
  bankName: "Banco Prueba",
  bankAccountHolder: "Titular Prueba",
  clabeNumber: "012345678901234567",
  cardNumber: "4111111111111111",
});

describe("GET /api/agencies/:id (datos privados de la agencia)", () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("sin autenticación responde 401 y no consulta la base", async () => {
    const find = mock.method(Agency, "findAgencyById", async (id: string) => fullAgencyRow(id));

    const res = await app.inject({ method: "GET", url: `/api/agencies/${AGENCY_A}` });

    assert.equal(res.statusCode, 401);
    assert.equal(find.mock.callCount(), 0);
    assert.ok(!res.body.includes("012345678901234567"), "no debe filtrar la CLABE");
  });

  it("un usuario de otra agencia recibe 403 y no se consulta la agencia ajena", async () => {
    const find = mock.method(Agency, "findAgencyById", async (id: string) => fullAgencyRow(id));

    const res = await app.inject({
      method: "GET",
      url: `/api/agencies/${AGENCY_B}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 403);
    assert.equal(find.mock.callCount(), 0);
    assert.ok(!res.body.includes("012345678901234567"));
  });

  it("un usuario autenticado consulta los datos privados de SU agencia", async () => {
    const find = mock.method(Agency, "findAgencyById", async (id: string) => fullAgencyRow(id));

    const res = await app.inject({
      method: "GET",
      url: `/api/agencies/${AGENCY_A}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(find.mock.calls[0]?.arguments[0], AGENCY_A);
    assert.equal(res.json().data.clabeNumber, "012345678901234567");
  });

  it("GET /api/agencies (Configuración) sigue devolviendo la agencia de la sesión", async () => {
    const find = mock.method(Agency, "findAgencyById", async (id: string) => fullAgencyRow(id));

    const res = await app.inject({
      method: "GET",
      url: "/api/agencies",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(find.mock.calls[0]?.arguments[0], AGENCY_A);
    assert.equal(res.json().data.id, AGENCY_A);
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

  // Lo que envía `AgencyTab`: solo los campos del formulario.
  const formBody = {
    name: "Agencia Prueba",
    phone: "5512345678",
    email: "privado@agencia.test",
    bankName: "Banco Prueba",
    bankAccountHolder: "Titular Prueba",
    address: "Calle 1",
    clabeNumber: "012345678901234567",
  };
  const patch = (payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: "/api/agencies",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload,
    });

  it("tarjeta vacía (opcional, decisión del PM) → se guarda como null", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch({ ...formBody, cardNumber: "" });

    assert.equal(res.statusCode, 200);
    const [agencyId, body] = update.mock.calls[0]!.arguments as [string, { cardNumber: unknown }];
    assert.equal(agencyId, AGENCY_A);
    assert.equal(body.cardNumber, null);
  });

  it("tarjeta sin enviar → no se modifica", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    await patch(formBody);

    const body = update.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.equal("cardNumber" in body, false);
  });

  it("tarjeta con menos de 16 dígitos → 400 sin guardar", async () => {
    const update = mock.method(Agency, "updateAgency", async () => ({}));

    const res = await patch({ ...formBody, cardNumber: "4111" });

    assert.equal(res.statusCode, 400);
    assert.equal(update.mock.callCount(), 0);
  });

  it("guardar la configuración no toca la suscripción (ni la regresa a prueba ni la reactiva)", async () => {
    const update = mock.method(Agency, "updateAgency", async (_id: string, body: unknown) => body);

    const res = await patch({ ...formBody, cardNumber: "4152313412345678" });

    assert.equal(res.statusCode, 200);
    const body = update.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.equal(body.cardNumber, "4152313412345678");
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

    const res = await patch({ ...formBody, address: null, cardNumber: "" });

    assert.equal(res.statusCode, 200);
    assert.equal((update.mock.calls[0]!.arguments[1] as { address: unknown }).address, null);
  });
});
