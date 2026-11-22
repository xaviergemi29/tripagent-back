import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import bcrypt from "bcryptjs";
import { db } from "../src/db/index.js";
import {
  resolveCorsOrigin,
  resolveSecrets,
  SecurityConfigError,
} from "../src/shared/security/security.config.js";
import { GENERIC_ERROR_MESSAGE } from "../src/shared/security/error-message.util.js";
import { TourSeatsService } from "../src/modules/tour-seats/tour-seats.service.js";
import {
  AGENCY_A,
  USER_A,
  chain,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

// Auditoría de seguridad (2026-11-13): secretos obligatorios, CORS con lista de orígenes,
// encabezados de seguridad, límite de intentos, login sin enumeración, errores sin SQL y
// registro del Magic Link de una sola vez.

const STRONG = "x".repeat(40);

describe("Configuración de seguridad", () => {
  it("JWT_SECRET y COOKIE_SECRET son obligatorios, largos y distintos", () => {
    assert.throws(() => resolveSecrets({ COOKIE_SECRET: STRONG }), SecurityConfigError);
    assert.throws(
      () => resolveSecrets({ JWT_SECRET: "corto", COOKIE_SECRET: STRONG }),
      SecurityConfigError,
    );
    assert.throws(() => resolveSecrets({ JWT_SECRET: STRONG, COOKIE_SECRET: STRONG }));
    assert.deepEqual(resolveSecrets({ JWT_SECRET: STRONG, COOKIE_SECRET: `${STRONG}y` }), {
      jwtSecret: STRONG,
      cookieSecret: `${STRONG}y`,
    });
  });

  it("CORS: en producción exige CORS_ORIGINS; en desarrollo solo localhost y red privada", () => {
    assert.throws(() => resolveCorsOrigin({ NODE_ENV: "production" }), SecurityConfigError);
    assert.deepEqual(
      resolveCorsOrigin({ NODE_ENV: "production", CORS_ORIGINS: "https://app.tripagent.mx/, " }),
      ["https://app.tripagent.mx"],
    );

    const [devPattern] = resolveCorsOrigin({ NODE_ENV: "development" }) as RegExp[];
    assert.ok(devPattern!.test("http://localhost:3000"));
    assert.ok(devPattern!.test("http://192.168.1.77:3000"));
    assert.ok(!devPattern!.test("https://evil.example"));
    assert.ok(!devPattern!.test("http://192.168.1.77.evil.example"));
  });
});

describe("API: CORS, encabezados, login y límite de intentos", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("un 500 nunca expone el mensaje interno: ni SQL de Drizzle ni el texto de un Error genérico", async () => {
    const dbError = new DrizzleQueryError(
      'select * from "travelers" where "whatsapp_phone" = $1',
      ["2281234567"],
      new Error("connect ECONNREFUSED"),
    );
    for (const error of [dbError, new Error("ruta interna /var/app: secreto")]) {
      mock.method(TourSeatsService, "getTourSeats", async () => {
        throw error;
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/seats/e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5/seats",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: GENERIC_ERROR_MESSAGE });
      mock.restoreAll();
    }
  });

  it("CORS no refleja orígenes desconocidos y sí permite el front local", async () => {
    const evil = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(evil.headers["access-control-allow-origin"], undefined);

    const front = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/login",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    assert.equal(front.headers["access-control-allow-origin"], "http://localhost:3000");
    assert.equal(front.headers["access-control-allow-credentials"], "true");
  });

  it("toda respuesta lleva encabezados de seguridad", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
  });

  it("login: mismo mensaje para correo inexistente y contraseña incorrecta, y bcrypt corre en ambos", async () => {
    const compare = mock.method(bcrypt, "compare", async () => false);
    mock.method(db.query.agencyUsers, "findFirst", (async () => null) as never);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nadie@agencia.mx", password: "secreta123" },
    });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), { error: "Credenciales inválidas" });
    // Se comparó contra el hash de relleno: el tiempo no revela si el correo existe.
    assert.equal(compare.mock.callCount(), 1);
    assert.match(String(compare.mock.calls[0]!.arguments[1]), /^\$2[aby]\$12\$/);

    mock.method(db.query.agencyUsers, "findFirst", (async () => ({
      id: USER_A,
      agencyId: AGENCY_A,
      email: "ana@agencia.mx",
      fullName: "Ana",
      role: "ADMIN",
      passwordHash: "$2b$12$abcdefghijklmnopqrstuuMZ3lnA8jzYbkxyIcaZ6P0X9oWQe6Gi",
    })) as never);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ana@agencia.mx", password: "incorrecta" },
    });
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), unknown.json());
  });

  it("login: el correo con espacios o mayúsculas se recorta y pasa a minúsculas antes de validar", async () => {
    let where: SQL | undefined;
    mock.method(bcrypt, "compare", async () => false);
    mock.method(db.query.agencyUsers, "findFirst", (async (args: { where?: SQL }) => {
      where = args.where;
      return null;
    }) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "  Ana.Mayus@Agencia.MX ", password: "secreta123" },
    });

    // Antes: 400 "Correo electrónico inválido" (z.email() validaba antes del trim).
    assert.equal(res.statusCode, 401);
    assert.ok(rowMatches(where, { email: "ana.mayus@agencia.mx", isActive: true }));
  });

  it("login: un fallo de la base es 500 genérico (sin SQL) y no un 401 con el detalle", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => {
      throw new DrizzleQueryError('select "password_hash" from "agency_users"', ["x@y.mx"]);
    }) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "x@y.mx", password: "secreta123" },
    });
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.body, /agency_users|password_hash|Failed query/);
  });

  it("login: la cookie de sesión dura lo mismo que el JWT (1 día)", async () => {
    mock.method(bcrypt, "compare", async () => true);
    mock.method(db.query.agencyUsers, "findFirst", (async () => ({
      id: USER_A,
      agencyId: AGENCY_A,
      email: "ana@agencia.mx",
      fullName: "Ana",
      role: "ADMIN",
      passwordHash: "hash",
      agency: { isActive: true, deletedAt: null },
    })) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ana@agencia.mx", password: "secreta123" },
    });
    assert.equal(res.statusCode, 200);
    const cookie = res.cookies.find((c) => c.name === "token")!;
    assert.equal(cookie.maxAge, 60 * 60 * 24);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Strict");
  });

  it("login: tras 10 intentos fallidos con el mismo correo responde 429 (otro correo no se bloquea)", async () => {
    mock.method(bcrypt, "compare", async () => false);
    mock.method(db.query.agencyUsers, "findFirst", (async () => null) as never);
    const attempt = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "203.0.113.7",
        payload: { email, password: "secreta123" },
      });

    for (let i = 0; i < 10; i++) {
      assert.equal((await attempt("Victima@Agencia.mx")).statusCode, 401);
    }
    // Las mayúsculas no evaden el límite por cuenta.
    const blocked = await attempt("VICTIMA@agencia.mx");
    assert.equal(blocked.statusCode, 429);
    assert.match(
      blocked.json().error,
      /^Demasiados intentos\. Vuelve a intentarlo en 15 minutos\.$/,
    );

    assert.equal((await attempt("otra@agencia.mx")).statusCode, 401);
  });

  it("pre-reserva pública: más de 10 solicitudes por hora desde la misma IP → 429", async () => {
    mock.method(db.query.tours, "findFirst", (async () => null) as never);
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) =>
      fn({
        execute: async () => [],
        query: { tours: { findFirst: async () => null } },
        select: () => chain([]),
      })) as never);
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/public/pre-booking",
        remoteAddress: "198.51.100.9",
        payload: {
          tourId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
          fullName: "Ana Torres",
          whatsapp: "2281234567",
          numberPassengers: 1,
        },
      });

    for (let i = 0; i < 10; i++) {
      assert.notEqual((await request()).statusCode, 429);
    }
    assert.equal((await request()).statusCode, 429);
  });

  it("una sesión válida sigue funcionando con los nuevos secretos", async () => {
    mock.method(db.query.agencyUsers, "findFirst", (async () => ({
      id: USER_A,
      agencyId: AGENCY_A,
      email: "ana@agencia.mx",
      fullName: "Ana",
      role: "ADMIN",
      agency: { name: "Viajes Xalapa", logoPath: null },
    })) as never);
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });
    assert.equal(res.statusCode, 200);
  });
});

describe("Magic Link: el registro del grupo solo se acepta una vez", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const payload = {
    token: "tok",
    mainClient: {
      fullName: "Intruso Pérez",
      whatsappPhone: "2289999999",
      email: "intruso@mail.com",
      emergencyContactName: "Alguien",
      emergencyContactPhone: "2281111111",
      birthDate: "1988-02-14",
      boardingPoint: "Plaza (06:00)",
    },
    hasCompanions: false,
    companions: [],
    privacyNoticeAccepted: true,
  };

  for (const status of ["PENDING", "CONFIRMED"] as const) {
    it(`reserva en ${status} (ya registrada): 409 sin tocar viajeros ni el manifiesto`, async () => {
      const writes: string[] = [];
      const tx = {
        query: {
          magicTokens: {
            findFirst: async () => ({
              id: "mt-1",
              token: "tok",
              bookingId: "booking-1",
              tourId: "tour-1",
              agencyId: AGENCY_A,
              numberPassengers: 2,
              currentUses: 1,
            }),
          },
          tours: { findFirst: async () => ({ id: "tour-1", agency: { name: "Viajes Xalapa" } }) },
          bookings: {
            findFirst: async () => ({ id: "booking-1", status, travelerId: "titular-original" }),
          },
          travelers: { findFirst: async () => ({ id: "otro-cliente" }) },
          bookingPassengers: { findMany: async () => [], findFirst: async () => null },
        },
        update: (table: Table) => {
          writes.push(`update ${getTableName(table)}`);
          return chain([]);
        },
        insert: (table: Table) => {
          writes.push(`insert ${getTableName(table)}`);
          return chain([{ id: "nuevo" }]);
        },
        select: () => chain([]),
      };
      mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/bookings/public/register",
        payload,
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya fue registrada/);
      assert.deepEqual(writes, []);
    });
  }
});
