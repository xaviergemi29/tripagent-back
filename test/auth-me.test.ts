import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

describe("GET /api/auth/me (sesión del panel)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const userRow = (logoPath: string | null) => ({
    id: USER_A,
    agencyId: AGENCY_A,
    email: "operador@agencia.test",
    fullName: "Operador Prueba",
    role: "ADMIN",
    agency: { name: "Bruji Tours", logoPath },
  });

  it("incluye el nombre y el logotipo de la agencia para el Sidebar", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () =>
      userRow("/uploads/logos/agency-a-1.png")) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.agencyName, "Bruji Tours");
    assert.equal(res.json().data.agencyLogoPath, "/uploads/logos/agency-a-1.png");
  });

  it("sin logotipo devuelve agencyLogoPath null", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => userRow(null)) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.json().data.agencyLogoPath, null);
  });
});
