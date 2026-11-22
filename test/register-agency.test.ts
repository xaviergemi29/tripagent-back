import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { AGENCY_A, USER_A, createTestApp, type TestApp } from "./helpers.js";

const validBody = {
  fullName: "Carlos Mendoza",
  agencyName: "Viajes Aventureros MX",
  whatsapp: "+522281234567",
  whatsappCountry: "MX",
  email: "  Carlos@TuAgencia.com ",
  password: "secreta123",
  plan: "todo-incluido",
};

/** Transacción falsa que guarda lo insertado y devuelve filas con ids fijos. */
function fakeRegistrationTx(opts: { failWith?: { code: string } } = {}) {
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const tx = {
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values });
        return {
          returning: async () => {
            if (opts.failWith) throw Object.assign(new Error("duplicado"), opts.failWith);
            return getTableName(table) === "agencies"
              ? [{ id: AGENCY_A }]
              : [
                  {
                    id: USER_A,
                    agencyId: AGENCY_A,
                    email: values.email,
                    fullName: values.fullName,
                    role: values.role,
                  },
                ];
          },
        };
      },
    }),
  };
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return inserts;
}

describe("POST /api/auth/register-agency (alta desde /registro)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const register = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/auth/register-agency", payload: body });

  it("crea agencia en prueba de 30 días + ADMIN y deja la sesión iniciada (cookie)", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => undefined) as never);
    const inserts = fakeRegistrationTx();
    const before = Date.now();

    const res = await register(validBody);

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().data.user.role, "ADMIN");
    assert.equal(res.json().data.user.agencyId, AGENCY_A);

    const agency = inserts.find((i) => i.table === "agencies")!.values;
    assert.equal(agency.name, "Viajes Aventureros MX");
    assert.equal(agency.email, "carlos@tuagencia.com");
    assert.equal(agency.phone, "+522281234567");
    assert.equal(agency.phoneCountry, "MX");
    assert.equal(agency.subscriptionStatus, "trialing");
    const trialDays = (Date.parse(agency.trialEndsAt as string) - before) / 86_400_000;
    assert.ok(trialDays > 29.99 && trialDays < 30.01, `prueba de ${trialDays} días`);

    const user = inserts.find((i) => i.table === "agency_users")!.values;
    assert.equal(user.role, "ADMIN");
    assert.equal(user.fullName, "Carlos Mendoza");
    assert.notEqual(user.passwordHash, "secreta123");
    assert.match(user.passwordHash as string, /^\$2[aby]\$12\$/);

    const cookie = res.cookies.find((c) => c.name === "token");
    assert.ok(cookie?.value, "abre la sesión con la cookie token");
    assert.equal(cookie.httpOnly, true);
    assert.ok(!res.body.includes("passwordHash"));
  });

  it("correo ya registrado → 409 sin escribir", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => ({ id: "u-1" })) as never);
    const inserts = fakeRegistrationTx();

    const res = await register(validBody);

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "Este correo ya está registrado. Inicia sesión.");
    assert.equal(inserts.length, 0);
  });

  it("dos registros simultáneos con el mismo correo (23505) → 409", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => undefined) as never);
    fakeRegistrationTx({ failWith: { code: "23505" } });

    const res = await register(validBody);

    assert.equal(res.statusCode, 409);
  });

  it("valida los datos (400): contraseña corta, correo, teléfono y lada del país", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => undefined) as never);
    const inserts = fakeRegistrationTx();
    // App propia: el límite de intentos (5 por hora por IP) es por instancia.
    const freshApp = await createTestApp();
    try {
      const send = (body: Record<string, unknown>) =>
        freshApp.inject({ method: "POST", url: "/api/auth/register-agency", payload: body });
      assert.equal((await send({ ...validBody, password: "corta" })).statusCode, 400);
      assert.equal((await send({ ...validBody, email: "no-es-correo" })).statusCode, 400);
      assert.equal((await send({ ...validBody, whatsapp: "123" })).statusCode, 400);
      assert.equal((await send({ ...validBody, whatsappCountry: "US" })).statusCode, 400);
      assert.equal((await send({ ...validBody, fullName: "Al" })).statusCode, 400);
      assert.equal(inserts.length, 0);
      // El sexto intento en la misma hora ya es 429.
      assert.equal((await send(validBody)).statusCode, 429);
    } finally {
      await freshApp.close();
    }
  });
});
