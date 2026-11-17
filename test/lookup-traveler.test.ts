import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { MagicTokenService } from "../src/modules/magic-tokens/magic-token.service.js";
import { TravelerService } from "../src/modules/travelers/travelers.service.js";
import { db } from "../src/db/index.js";
import { AGENCY_A, createTestApp, type TestApp } from "./helpers.js";

// Fila completa del viajero tal como la devuelve la base de datos.
const travelerRow = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agencyId: AGENCY_A,
  fullName: "Viajero Frecuente",
  whatsappPhone: "5512345678",
  email: "viajero@test.mx",
  emergencyContactName: "Contacto Secreto",
  emergencyContactPhone: "5599999999",
  medicalNotes: "Alergia confidencial",
  birthDate: "1990-05-10",
  customFields: { interno: "dato-interno" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

/** Token cuya reserva sigue esperando el registro del grupo (`findRegistrationContext`). */
const validToken = { agencyId: AGENCY_A };

const lookupUrl = (phone = travelerRow.whatsappPhone) =>
  `/api/magic-tokens/token-de-prueba/lookup-traveler?phone=${phone}`;

describe("GET /api/magic-tokens/:token/lookup-traveler (ruta pública)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  // Contrato vigente (definido en magic-token.routes.ts tras la revisión del 2026-11-11).
  it("devuelve exactamente fullName, email, contactos de emergencia y birthDate", async () => {
    mock.method(MagicTokenService, "findRegistrationContext", (async () => validToken) as never);
    const find = mock.method(
      TravelerService,
      "findSingleTravelerByPhone",
      (async () => travelerRow) as never,
    );

    const res = await app.inject({ method: "GET", url: lookupUrl() });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      fullName: travelerRow.fullName,
      email: travelerRow.email,
      emergencyContactName: travelerRow.emergencyContactName,
      emergencyContactPhone: travelerRow.emergencyContactPhone,
      birthDate: travelerRow.birthDate,
    });
    // La búsqueda se limita a la agencia del token, no a una enviada por el cliente. Los 10 dígitos
    // de un cliente anterior llegan al servicio ya normalizados a E.164 (México).
    assert.deepEqual(find.mock.calls[0]?.arguments, ["+525512345678", AGENCY_A]);
  });

  it("no expone notas médicas, teléfono ni datos internos", async () => {
    mock.method(MagicTokenService, "findRegistrationContext", (async () => validToken) as never);
    mock.method(TravelerService, "findSingleTravelerByPhone", (async () => travelerRow) as never);

    const res = await app.inject({ method: "GET", url: lookupUrl() });

    for (const secret of [
      travelerRow.medicalNotes,
      travelerRow.id,
      travelerRow.agencyId,
      "dato-interno",
    ]) {
      assert.ok(!res.body.includes(secret), `la respuesta pública contiene "${secret}"`);
    }
  });

  it("viajero no registrado: 404 (el front lo trata como 'sin coincidencias')", async () => {
    mock.method(MagicTokenService, "findRegistrationContext", (async () => validToken) as never);
    mock.method(TravelerService, "findSingleTravelerByPhone", (async () => undefined) as never);

    const res = await app.inject({ method: "GET", url: lookupUrl("5500000000") });

    assert.equal(res.statusCode, 404);
  });

  it("token inválido: 400 y no busca viajeros", async () => {
    mock.method(MagicTokenService, "findRegistrationContext", (async () => null) as never);
    const find = mock.method(
      TravelerService,
      "findSingleTravelerByPhone",
      (async () => travelerRow) as never,
    );

    const res = await app.inject({ method: "GET", url: lookupUrl() });

    assert.equal(res.statusCode, 400);
    assert.equal(find.mock.callCount(), 0);
  });

  // Auditoría 2026-11-15: el enlace no vence, así que después del registro (que se acepta una sola
  // vez) la búsqueda por teléfono ya no tiene uso y solo serviría para enumerar clientes.
  describe("findRegistrationContext (candado por estado de la reserva)", () => {
    const tokenRow = (status: string, deletedAt: string | null = null) => ({
      agencyId: AGENCY_A,
      booking: { status, deletedAt },
    });

    it("reserva en AWAITING_REGISTRATION → devuelve la agencia del token", async () => {
      mock.method(db.query.magicTokens, "findFirst", (async () =>
        tokenRow("AWAITING_REGISTRATION")) as never);
      assert.deepEqual(await MagicTokenService.findRegistrationContext("t"), {
        agencyId: AGENCY_A,
      });
    });

    for (const status of ["PENDING", "CONFIRMED", "CANCELLED"]) {
      it(`reserva ya registrada (${status}) → null y la ruta responde 400 sin buscar`, async () => {
        mock.method(db.query.magicTokens, "findFirst", (async () => tokenRow(status)) as never);
        const find = mock.method(
          TravelerService,
          "findSingleTravelerByPhone",
          (async () => travelerRow) as never,
        );

        const res = await app.inject({ method: "GET", url: lookupUrl() });

        assert.equal(res.statusCode, 400);
        assert.equal(find.mock.callCount(), 0);
      });
    }

    it("reserva borrada o token inexistente → null", async () => {
      mock.method(db.query.magicTokens, "findFirst", (async () =>
        tokenRow("AWAITING_REGISTRATION", "2026-11-01T00:00:00Z")) as never);
      assert.equal(await MagicTokenService.findRegistrationContext("t"), null);
      mock.restoreAll();
      mock.method(db.query.magicTokens, "findFirst", (async () => undefined) as never);
      assert.equal(await MagicTokenService.findRegistrationContext("t"), null);
    });
  });
});
