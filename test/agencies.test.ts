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
