import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  USER_B,
  chain,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

// Transferencia de lugar: re-vincula el lugar a otro viajero; el titular hereda el saldo y,
// si cambia el WhatsApp, se regenera el Magic Link.
const BOOKING_ID = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const TOUR_ID = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
const TITULAR_ID = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";
const COMPANION_ID = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4";

const booking = {
  id: BOOKING_ID,
  agencyId: AGENCY_A,
  tourId: TOUR_ID,
  travelerId: TITULAR_ID,
  status: "PENDING",
  paymentStatus: "PARTIAL",
  totalPrice: 4000,
  amountPaid: 1500,
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  magicToken: { token: "tokenoriginal" },
};

const titularSlot = {
  id: "bp-titular",
  bookingId: BOOKING_ID,
  travelerId: TITULAR_ID,
  isTitular: true,
  status: "ACTIVE",
  boardingPoint: "Xalapa (06:00)",
  seatLabel: "3A",
  traveler: { id: TITULAR_ID, whatsappPhone: "2281111111" },
};

const companionSlot = {
  id: "bp-companion",
  bookingId: BOOKING_ID,
  travelerId: COMPANION_ID,
  isTitular: false,
  status: "ACTIVE",
  boardingPoint: "Coatepec (06:30)",
  seatLabel: "3B",
  traveler: { id: COMPANION_ID, whatsappPhone: null },
};

interface FakeOptions {
  slot: typeof titularSlot | typeof companionSlot;
  existingTraveler?: { id: string };
  alreadyInTour?: unknown;
}

function fakeTransaction(opts: FakeOptions) {
  const updates: { table: string; set: Record<string, unknown> }[] = [];
  const inserts: { table: string; values: Record<string, unknown> }[] = [];

  const tx = {
    select: () => chain(undefined),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values });
        return { returning: async () => [{ id: "traveler-new" }] };
      },
    }),
    update: (table: Table) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table: getTableName(table), set });
        return chain(undefined);
      },
    }),
    query: {
      bookings: {
        findFirst: async ({ where }: { where?: SQL }) => {
          // La primera lectura filtra por agencia; la relectura final solo por id.
          try {
            return rowMatches(where, booking) ? booking : undefined;
          } catch {
            return booking;
          }
        },
      },
      travelers: { findFirst: async () => opts.existingTraveler },
      bookingPassengers: {
        findFirst: async (args: { with?: unknown; where?: SQL }) => {
          if (args.with) return opts.slot; // lugar a transferir
          try {
            // Búsqueda del titular para heredar el punto de abordaje (solo eq).
            return rowMatches(args.where, titularSlot) ? titularSlot : undefined;
          } catch {
            return opts.alreadyInTour; // anti-duplicado (usa inArray)
          }
        },
      },
    },
  };

  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return { updates, inserts };
}

describe("PATCH /api/bookings/:bookingId/transfer", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const transfer = (payload: Record<string, unknown>, agencyId = AGENCY_A, userId = USER_A) =>
    app.inject({
      method: "PATCH",
      url: `/api/bookings/${BOOKING_ID}/transfer`,
      cookies: sessionCookie(app, agencyId, userId),
      payload,
    });

  const titularPayload = {
    passengerId: TITULAR_ID,
    role: "TITULAR",
    fullName: "Nuevo Titular",
    whatsapp: "2289999999",
    email: "nuevo@correo.mx",
    isMinor: false,
  };

  it("titular con WhatsApp nuevo: crea viajero sin datos heredados, cambia dueño y regenera el token", async () => {
    const { updates, inserts } = fakeTransaction({ slot: titularSlot });

    const res = await transfer(titularPayload);

    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.equal(data.tokenRegenerated, true);
    assert.equal(data.amountPaid, 1500); // el saldo se hereda, no se toca

    const traveler = inserts.find((i) => i.table === "travelers")!.values;
    // Sin notas médicas desde el 2026-11-22 (dato sensible, LFPDPPP): ni se capturan ni se heredan.
    assert.ok(!("medicalNotes" in traveler));
    assert.equal(traveler.agencyId, AGENCY_A);

    // El viajero original no se modifica.
    assert.ok(!updates.some((u) => u.table === "travelers"));
    const slotUpdate = updates.find((u) => u.table === "booking_passengers")!.set;
    assert.equal(slotUpdate.travelerId, "traveler-new");
    assert.equal(slotUpdate.boardingPoint, "Xalapa (06:00)");
    assert.ok(!("seatLabel" in slotUpdate)); // el asiento se conserva
    assert.equal(updates.find((u) => u.table === "bookings")!.set.travelerId, "traveler-new");
    const token = updates.find((u) => u.table === "magic_tokens")!.set.token as string;
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(!updates.some((u) => u.table === "payments"));
  });

  it("titular con el mismo WhatsApp: corrige datos sin regenerar el token", async () => {
    const { updates } = fakeTransaction({
      slot: titularSlot,
      existingTraveler: { id: TITULAR_ID },
    });

    const res = await transfer({ ...titularPayload, whatsapp: "2281111111" });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.tokenRegenerated, false);
    assert.ok(!updates.some((u) => u.table === "magic_tokens"));
    assert.ok(!updates.some((u) => u.table === "bookings"));
    // Sin acordeón, el contacto de emergencia del mismo viajero no se toca.
    assert.ok(!("emergencyContactName" in updates.find((u) => u.table === "travelers")!.set));
  });

  it("titular con el mismo número en E.164 (guardado con 10 dígitos): no regenera y confirma la lada", async () => {
    const { updates } = fakeTransaction({
      slot: titularSlot,
      existingTraveler: { id: TITULAR_ID },
    });

    const res = await transfer({
      ...titularPayload,
      whatsapp: "+522281111111",
      whatsappCountry: "MX",
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.tokenRegenerated, false);
    const travelerSet = updates.find((u) => u.table === "travelers")!.set;
    assert.equal(travelerSet.whatsappPhone, "+522281111111");
    assert.equal(travelerSet.whatsappCountry, "MX");
  });

  it("acompañante menor sin WhatsApp: viajero nuevo CHILD, hereda el abordaje del titular, sin token", async () => {
    const { updates, inserts } = fakeTransaction({ slot: companionSlot });

    const res = await transfer({
      passengerId: COMPANION_ID,
      role: "COMPANION",
      fullName: "Niña Nueva",
      isMinor: true,
      inheritTitularBoardingPoint: true,
    });

    assert.equal(res.statusCode, 200);
    const traveler = inserts.find((i) => i.table === "travelers")!.values;
    assert.equal(traveler.whatsappPhone, null);
    assert.equal(traveler.email, null);
    assert.ok(!("medicalNotes" in traveler));
    const slotUpdate = updates.find((u) => u.table === "booking_passengers")!.set;
    assert.equal(slotUpdate.passengerType, "CHILD");
    assert.equal(slotUpdate.boardingPoint, "Xalapa (06:00)");
    assert.ok(!updates.some((u) => u.table === "magic_tokens" || u.table === "bookings"));
  });

  it("acompañante sin heredar abordaje conserva el punto del lugar", async () => {
    const { updates } = fakeTransaction({ slot: companionSlot });

    const res = await transfer({
      passengerId: COMPANION_ID,
      role: "COMPANION",
      fullName: "Adulto Nuevo",
      whatsapp: "2287777777",
      email: "adulto@correo.mx",
      isMinor: false,
      inheritTitularBoardingPoint: false,
    });

    assert.equal(res.statusCode, 200);
    const slotUpdate = updates.find((u) => u.table === "booking_passengers")!.set;
    assert.equal(slotUpdate.boardingPoint, "Coatepec (06:30)");
  });

  it("la persona destino ya tiene lugar activo en el tour → 409 sin re-vincular", async () => {
    const { updates } = fakeTransaction({
      slot: titularSlot,
      existingTraveler: { id: "otro-viajero" },
      alreadyInTour: { id: "bp-otro" },
    });

    const res = await transfer(titularPayload);

    assert.equal(res.statusCode, 409);
    assert.ok(!updates.some((u) => u.table === "booking_passengers"));
  });

  it("valida el payload: titular menor, adulto sin correo y rol que no coincide", async () => {
    fakeTransaction({ slot: titularSlot });
    assert.equal((await transfer({ ...titularPayload, isMinor: true })).statusCode, 400);
    assert.equal((await transfer({ ...titularPayload, email: "" })).statusCode, 400);

    fakeTransaction({ slot: companionSlot });
    const res = await transfer({ ...titularPayload, passengerId: COMPANION_ID });
    assert.equal(res.statusCode, 400);
  });

  it("una reserva de otra agencia → 404", async () => {
    fakeTransaction({ slot: titularSlot });

    const res = await transfer(titularPayload, AGENCY_B, USER_B);

    assert.equal(res.statusCode, 404);
  });
});
