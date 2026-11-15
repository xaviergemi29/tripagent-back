import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TourSeatsService } from "../src/modules/tour-seats/tour-seats.service.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../src/shared/errors/domain-errors.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Auditoría de arquitectura (2026-11-14): las rutas ya no traducen errores a mano ni comparan el
// texto del mensaje. Lo hace el manejador global de app.ts.

const TOUR_ID = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";

describe("Manejador global de errores", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const getSeats = () =>
    app.inject({
      method: "GET",
      url: `/api/seats/${TOUR_ID}/seats`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

  const cases: [string, Error, number][] = [
    ["NotFoundError → 404", new NotFoundError("Tour no encontrado"), 404],
    ["BusinessRuleError → 400", new BusinessRuleError("Regla incumplida"), 400],
    ["ConflictError → 409", new ConflictError("Conflicto de estado"), 409],
  ];
  for (const [name, error, status] of cases) {
    it(name, async () => {
      mock.method(TourSeatsService, "getTourSeats", async () => {
        throw error;
      });

      const res = await getSeats();

      assert.equal(res.statusCode, status);
      assert.deepEqual(res.json(), { error: error.message });
    });
  }

  it("un error inesperado es 500 genérico y no expone el SQL", async () => {
    mock.method(TourSeatsService, "getTourSeats", async () => {
      throw new Error('Failed query: select * from "tours" params: secreto');
    });

    const res = await getSeats();

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "Error interno del servidor" });
  });

  it("los 4xx de Fastify (validación) conservan su formato", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/seats/no-es-uuid/seats",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "FST_ERR_VALIDATION");
  });
});
