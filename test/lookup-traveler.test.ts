import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { MagicTokenService } from "../src/modules/magic-tokens/magic-token.service.js";
import { TravelerService } from "../src/modules/travelers/travelers.service.js";
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

const validToken = {
  isValid: true,
  flowState: "PENDING_REGISTRATION",
  meta: { agencyId: AGENCY_A, tourId: "t", bookingId: "b" },
  data: {},
};

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

  it("devuelve exactamente los campos que autocompleta el front (fullName, email, birthDate)", async () => {
    mock.method(MagicTokenService, "validate", (async () => validToken) as never);
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
      birthDate: travelerRow.birthDate,
    });
    // La búsqueda se limita a la agencia del token, no a una enviada por el cliente.
    assert.deepEqual(find.mock.calls[0]?.arguments, [travelerRow.whatsappPhone, AGENCY_A]);
  });

  it("no expone notas médicas, contactos de emergencia ni datos internos", async () => {
    mock.method(MagicTokenService, "validate", (async () => validToken) as never);
    mock.method(TravelerService, "findSingleTravelerByPhone", (async () => travelerRow) as never);

    const res = await app.inject({ method: "GET", url: lookupUrl() });

    for (const secret of [
      travelerRow.medicalNotes,
      travelerRow.emergencyContactName,
      travelerRow.emergencyContactPhone,
      travelerRow.id,
      travelerRow.agencyId,
      "dato-interno",
    ]) {
      assert.ok(!res.body.includes(secret), `la respuesta pública contiene "${secret}"`);
    }
  });

  it("viajero no registrado: 404 (el front lo trata como 'sin coincidencias')", async () => {
    mock.method(MagicTokenService, "validate", (async () => validToken) as never);
    mock.method(TravelerService, "findSingleTravelerByPhone", (async () => undefined) as never);

    const res = await app.inject({ method: "GET", url: lookupUrl("5500000000") });

    assert.equal(res.statusCode, 404);
  });

  it("token inválido: 400 y no busca viajeros", async () => {
    mock.method(MagicTokenService, "validate", (async () => ({
      error: { code: "NOT_FOUND" },
    })) as never);
    const find = mock.method(
      TravelerService,
      "findSingleTravelerByPhone",
      (async () => travelerRow) as never,
    );

    const res = await app.inject({ method: "GET", url: lookupUrl() });

    assert.equal(res.statusCode, 400);
    assert.equal(find.mock.callCount(), 0);
  });
});
