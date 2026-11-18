import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { getTodayInMexico } from "../src/shared/utils/mexico-date.util.js";
import { AGENCY_A, USER_A, chain, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Reglas de fechas (2026-11-17): fecha de nacimiento obligatoria y no futura en el Magic Link, y un
// tour no sale antes de hoy (hora de CDMX).

const TOUR_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const shiftDays = (days: number) => {
  const d = new Date(`${getTodayInMexico()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe("Reglas de fechas", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const mainClient = {
    fullName: "Ana Torres",
    whatsappPhone: "2281234567",
    email: "ana@correo.mx",
    emergencyContactName: "Luis Torres",
    emergencyContactPhone: "2281112222",
    boardingPoint: "Plaza (06:00)",
  };
  const register = (birthDate: string | undefined, companionBirthDate?: string) =>
    app.inject({
      method: "POST",
      url: "/api/bookings/public/register",
      payload: {
        token: "tok",
        mainClient: { ...mainClient, ...(birthDate === undefined ? {} : { birthDate }) },
        hasCompanions: companionBirthDate !== undefined,
        companionMethod: "MANUAL",
        companions:
          companionBirthDate === undefined
            ? []
            : [
                {
                  fullName: "Leo Torres",
                  passengerType: "CHILD",
                  emergencyContactName: "Luis Torres",
                  emergencyContactPhone: "2281112222",
                  birthDate: companionBirthDate,
                  boardingPoint: "Plaza (06:00)",
                },
              ],
        privacyNoticeAccepted: true,
      },
    });

  it("Magic Link: sin fecha de nacimiento del titular → 400", async () => {
    const res = await register(undefined);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /fecha de nacimiento es obligatoria/);
  });

  it("Magic Link: fecha de nacimiento vacía del acompañante → 400", async () => {
    const res = await register("1990-05-01", "");
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /fecha de nacimiento es obligatoria/);
  });

  it("Magic Link: fecha de nacimiento futura → 400", async () => {
    const res = await register(shiftDays(1));
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /no puede ser futura/);
  });

  it("crear un tour con salida antes de hoy → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tours",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: {
        title: "Zacatlán",
        price: 1200,
        depositPerPerson: 0,
        departureDateTime: shiftDays(-1),
        maxCapacity: 20,
        acceptsCash: true,
        cashInstructions: "Paga directo al abordar",
        boardingPoints: [{ location: "Plaza Central", time: "06:00" }],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /no puede ser anterior a hoy/);
  });

  it("editar: mover la salida al pasado → 400; conservar la fecha guardada no se rechaza por eso", async () => {
    // Tour EN CURSO (salió ayer y regresa en dos días): sigue editable. Uno FINALIZADO o CANCELADO
    // responde 409 por el Modo Auditoría (audit-mode.test.ts).
    const past = shiftDays(-1);
    const tx = {
      select: () =>
        chain([
          {
            maxCapacity: 20,
            staffCapacity: 0,
            departureDateTime: past,
            returnDate: shiftDays(2),
            cancelledAt: null,
          },
        ]),
    };
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
    const patch = (departureDateTime: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { departureDateTime },
      });

    const moved = await patch(shiftDays(-2));
    assert.equal(moved.statusCode, 400);
    assert.match(moved.json().error, /no puede ser anterior a hoy/);

    const kept = await patch(past);
    assert.doesNotMatch(kept.body, /no puede ser anterior a hoy/);
  });
});
