import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { BookingService } from "../src/modules/bookings/booking.service.js";
import {
  isSamePhone,
  normalizePhone,
  phoneLookupCandidates,
} from "../src/shared/utils/phone.util.js";
import {
  confirmLegacyPhone,
  fillEmptyTravelerFields,
} from "../src/shared/utils/traveler-merge.util.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

// Teléfonos internacionales (2026-11-16): E.164 + país, compatibilidad con los 10 dígitos anteriores.
const TOUR_ID = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7";
const TRAVELER_ID = "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7";

describe("phone.util", () => {
  it("normaliza a E.164: nacional con país, internacional y formatos anteriores (México)", () => {
    assert.equal(normalizePhone("2281234567"), "+522281234567"); // 10 dígitos anteriores
    assert.equal(normalizePhone("+2281234567"), "+522281234567"); // "+" + 10 dígitos (apartado rápido)
    assert.equal(normalizePhone("522281234567"), "+522281234567"); // con lada sin "+"
    assert.equal(normalizePhone("612345678", "ES"), "+34612345678");
    assert.equal(normalizePhone("+1 (212) 555-1234"), "+12125551234");
    assert.equal(normalizePhone("0034612345678"), "+34612345678");
  });

  it("rechaza números inválidos o cuya lada no corresponde al país", () => {
    assert.equal(normalizePhone("123"), null);
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone("+12125551234", "MX"), null);
    assert.equal(normalizePhone("+12125551234", "CA"), "+12125551234"); // +1 compartido
  });

  it("los candidatos de búsqueda incluyen los formatos anteriores solo para números mexicanos", () => {
    assert.deepEqual(phoneLookupCandidates("+522281234567"), [
      "+522281234567",
      "2281234567",
      "+2281234567",
    ]);
    assert.deepEqual(phoneLookupCandidates("+12125551234"), ["+12125551234"]);
  });

  it("compara números en cualquier formato; un número de EE. UU. no es el mismo de 10 dígitos de México", () => {
    assert.equal(isSamePhone("2281234567", "+522281234567"), true);
    assert.equal(isSamePhone("+12125551234", "2125551234"), false);
    assert.equal(isSamePhone(null, undefined), true);
    assert.equal(isSamePhone(null, "+522281234567"), false);
  });

  it("confirma la lada de un registro anterior sin sobrescribir un país ya confirmado", () => {
    const incoming = { whatsappPhone: "+522281234567", whatsappCountry: "MX" };
    assert.deepEqual(confirmLegacyPhone({ whatsappCountry: null }, incoming), incoming);
    assert.deepEqual(confirmLegacyPhone({ whatsappCountry: "US" }, incoming), {});
    assert.deepEqual(confirmLegacyPhone({ whatsappCountry: null }, { whatsappPhone: "+5222" }), {});
  });

  it("el país del teléfono de emergencia solo se completa junto con su número", () => {
    const patch = fillEmptyTravelerFields(
      { emergencyContactPhone: "" },
      { emergencyContactPhone: "+34612345678", emergencyContactCountry: "ES" },
    );
    assert.equal(patch.emergencyContactPhone, "+34612345678");
    assert.equal(patch.emergencyContactCountry, "ES");
    const kept = fillEmptyTravelerFields(
      { emergencyContactPhone: "+522281234567" },
      { emergencyContactPhone: "+34612345678", emergencyContactCountry: "ES" },
    );
    assert.deepEqual(kept, {});
  });
});

describe("Contrato de teléfonos en las rutas", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const quickBooking = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/bookings/${TOUR_ID}/quick-booking`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { fullName: "Cliente Prueba", email: "c@test.mx", numberPassengers: 1, ...payload },
    });

  it("apartado rápido: el servicio recibe E.164 y el país (Canadá comparte el +1)", async () => {
    const create = mock.method(BookingService, "createQuickBooking", async () => ({
      bookingId: "b",
      token: "t",
      availableSeats: 3,
    }));

    const res = await quickBooking({ whatsapp: "+16045551234", whatsappCountry: "ca" });

    assert.equal(res.statusCode, 201);
    const body = create.mock.calls[0]?.arguments[1] as Record<string, unknown>;
    assert.equal(body.whatsapp, "+16045551234");
    assert.equal(body.whatsappCountry, "CA");
  });

  it("apartado rápido: cliente anterior con 10 dígitos → México sin confirmar", async () => {
    const create = mock.method(BookingService, "createQuickBooking", async () => ({}));

    const res = await quickBooking({ whatsapp: "5512345678" });

    assert.equal(res.statusCode, 201);
    const body = create.mock.calls[0]?.arguments[1] as Record<string, unknown>;
    assert.equal(body.whatsapp, "+525512345678");
    assert.equal(body.whatsappCountry, undefined);
  });

  it("400 si la lada no corresponde al país, si el país no existe o si el número es inválido", async () => {
    const create = mock.method(BookingService, "createQuickBooking", async () => ({}));

    for (const payload of [
      { whatsapp: "+12125551234", whatsappCountry: "MX" },
      { whatsapp: "+522281234567", whatsappCountry: "ZZ" },
      { whatsapp: "+34123", whatsappCountry: "ES" },
    ]) {
      const res = await quickBooking(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(create.mock.callCount(), 0);
  });

  it("editar un viajero con un número que otro ya tiene en el formato anterior → 409", async () => {
    mock.method(db.query.travelers, "findFirst", (async () => ({ id: "otro-viajero" })) as never);
    const update = mock.method(db, "update", () => {
      throw new Error("no debe escribir");
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/travelers/${TRAVELER_ID}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { whatsappPhone: "+522281234567", whatsappCountry: "MX" },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "Ya existe un viajero registrado con ese WhatsApp");
    assert.equal(update.mock.callCount(), 0);
  });
});
