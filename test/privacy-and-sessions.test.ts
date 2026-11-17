import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { fillEmptyTravelerFields } from "../src/shared/utils/traveler-merge.util.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Decisiones del PM (2026-11-14):
// A1. Casilla obligatoria "Acepto el aviso de privacidad" (LFPDPPP), con fecha de aceptación.
// A2. El registro público solo completa campos vacíos de un viajero que ya existía.
// B1. Desactivar a un usuario corta su sesión en la siguiente petición.

describe("A2. fillEmptyTravelerFields: solo completa campos vacíos", () => {
  it("respeta los datos existentes y llena los vacíos", () => {
    assert.deepEqual(
      fillEmptyTravelerFields(
        {
          fullName: "Ana Torres",
          email: "ana@correo.mx",
          emergencyContactName: null,
          emergencyContactPhone: "",
          medicalNotes: "Alergia a la penicilina",
          birthDate: null,
        },
        {
          fullName: "Bromista",
          email: "otro@correo.mx",
          emergencyContactName: "Luis Torres",
          emergencyContactPhone: "2281112222",
          medicalNotes: "",
          birthDate: "1990-05-01",
        },
      ),
      {
        emergencyContactName: "Luis Torres",
        emergencyContactPhone: "2281112222",
        birthDate: "1990-05-01",
      },
    );
  });

  it('el correo "N/A" de un menor cuenta como vacío', () => {
    assert.deepEqual(fillEmptyTravelerFields({ email: "N/A" }, { email: "mateo@correo.mx" }), {
      email: "mateo@correo.mx",
    });
  });
});

describe("A1 y A2. Registro público del Magic Link", () => {
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
      fullName: "Nombre Distinto",
      whatsappPhone: "2281234567",
      email: "nuevo@correo.mx",
      emergencyContactName: "Luis Torres",
      emergencyContactPhone: "2281112222",
      birthDate: "1990-05-01",
      boardingPoint: "Plaza (06:00)",
    },
    hasCompanions: false,
    companionMethod: "MANUAL",
    companions: [],
  };

  /** Transacción falsa del registro: el titular ya existe en la agencia con nombre y correo. */
  function fakeRegistration() {
    const updates: { table: string; values: Record<string, unknown> }[] = [];
    const tx = {
      query: {
        magicTokens: {
          findFirst: async () => ({
            id: "mt-1",
            token: "tok",
            bookingId: "booking-1",
            tourId: "tour-1",
            agencyId: AGENCY_A,
            numberPassengers: 1,
            currentUses: 1,
          }),
        },
        tours: {
          findFirst: async () => ({
            id: "tour-1",
            price: 1000,
            depositPerPerson: 0,
            agency: { name: "Viajes Xalapa" },
          }),
        },
        bookings: {
          findFirst: async () => ({
            id: "booking-1",
            status: "AWAITING_REGISTRATION",
            travelerId: "titular-1",
            totalPrice: 1000,
            amountPaid: 0,
            magicToken: { numberPassengers: 1 },
            tour: { price: 1000, depositPerPerson: 0 },
          }),
        },
        travelers: {
          findFirst: async () => ({
            id: "titular-1",
            fullName: "Ana Torres",
            email: "ana@correo.mx",
            emergencyContactName: null,
            emergencyContactPhone: null,
            medicalNotes: null,
            birthDate: null,
          }),
        },
        bookingPassengers: { findMany: async () => [], findFirst: async () => null },
      },
      update: (table: Table) => ({
        set: (values: Record<string, unknown>) => {
          updates.push({ table: getTableName(table), values });
          return chain([]);
        },
      }),
      insert: () => chain([{ id: "nuevo" }]),
      select: () => chain([]),
    };
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
    return { updates };
  }

  const register = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/bookings/public/register", payload: body });

  it("sin aceptar el aviso de privacidad → 400 sin escribir", async () => {
    const { updates } = fakeRegistration();

    const res = await register(payload);

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /aviso de privacidad/);
    assert.equal(updates.length, 0);
  });

  it("aceptándolo: guarda la fecha de aceptación y no sobrescribe el nombre ni el correo", async () => {
    const { updates } = fakeRegistration();

    const res = await register({ ...payload, privacyNoticeAccepted: true });

    assert.equal(res.statusCode, 201);
    const travelerUpdate = updates.find((u) => u.table === "travelers")!;
    assert.equal(travelerUpdate.values.fullName, undefined); // "Ana Torres" se respeta
    assert.equal(travelerUpdate.values.email, undefined); // el correo del CRM se respeta
    assert.equal(travelerUpdate.values.emergencyContactName, "Luis Torres"); // estaba vacío
    const bookingUpdate = updates.find(
      (u) => u.table === "bookings" && "privacyNoticeAcceptedAt" in u.values,
    );
    assert.ok(bookingUpdate, "la reserva guarda privacyNoticeAcceptedAt");
  });
});

describe("B1. Sesión revocable al desactivar al usuario", () => {
  it("usuario desactivado: 401 en su siguiente petición, aunque la cookie siga vigente", async () => {
    const app = await createTestApp({ isSessionActive: async () => false });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/agencies",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /desactivado/);
    } finally {
      await app.close();
    }
  });

  it("la verificación recibe el usuario y la agencia del token", async () => {
    const calls: [string, string][] = [];
    const app = await createTestApp({
      isSessionActive: async (userId, agencyId) => {
        calls.push([userId, agencyId]);
        return true;
      },
    });
    try {
      mock.method(db.query.agencies, "findFirst", (async () => ({ id: AGENCY_A })) as never);
      await app.inject({
        method: "GET",
        url: "/api/agencies",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });

      assert.deepEqual(calls, [[USER_A, AGENCY_A]]);
    } finally {
      mock.restoreAll();
      await app.close();
    }
  });
});
