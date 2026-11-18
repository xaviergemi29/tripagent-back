import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  chain,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

// Decisión del PM: sin sobreventa. Cupo = (total − staff) − ocupados, validado atómicamente.
const TOUR_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const OTHER_TOUR_ID = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const BOOKING_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";

const baseTour = {
  id: TOUR_ID,
  agencyId: AGENCY_A,
  price: 1000,
  maxCapacity: 10,
  staffCapacity: 2, // 8 vendibles
  departureDateTime: "2026-12-20",
  cancelledAt: null,
  deletedAt: null,
  // Agencia con plan activo: la pre-reserva no está en pausa por suscripción.
  agency: { subscriptionStatus: "active", trialEndsAt: null, createdAt: "2026-01-01T00:00:00Z" },
};

/** Reservas activas: grupos de 4 y 2 → 6 ocupados (2 disponibles). */
const sixOccupied = [
  { totalPrice: 4000, magicToken: { numberPassengers: 4 } },
  { totalPrice: 2000, magicToken: { numberPassengers: 2 } },
];

interface FakeOptions {
  tour?: Record<string, unknown>;
  occupied?: unknown[];
  existingTraveler?: { id: string } | undefined;
  passengerInTour?: unknown;
  booking?: Record<string, unknown>;
}

/**
 * Transacción falsa que registra el orden de las operaciones (`log`) y lo insertado (`inserts`).
 * El SELECT … FOR UPDATE del tour devuelve la fila de capacidad.
 */
function fakeTransaction(opts: FakeOptions = {}) {
  const tour = { ...baseTour, ...opts.tour };
  const log: string[] = [];
  const inserts: { table: string; values: Record<string, unknown> }[] = [];

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (mode: string) => {
            log.push(`lock:${mode}`);
            return [tour];
          },
        }),
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        log.push(`insert:${getTableName(table)}`);
        inserts.push({ table: getTableName(table), values });
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: `${getTableName(table)}-new` }],
        });
      },
    }),
    update: () => chain(undefined),
    query: {
      tours: {
        findFirst: async ({ where }: { where?: SQL }) =>
          rowMatches(where, tour) ? tour : undefined,
      },
      bookings: {
        findMany: async () => {
          log.push("count-occupied");
          return opts.occupied ?? sixOccupied;
        },
        findFirst: async () => opts.booking,
      },
      travelers: {
        findFirst: async () => opts.existingTraveler,
      },
      bookingPassengers: {
        findFirst: async () => opts.passengerInTour,
      },
      magicTokens: {
        findFirst: async () => ({ id: "mt-1", numberPassengers: 2 }),
      },
    },
  };

  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return { log, inserts };
}

describe("Cupo y sobreventa", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  describe("POST /api/bookings/:id/quick-booking", () => {
    const quickBooking = (numberPassengers: number) =>
      app.inject({
        method: "POST",
        url: `/api/bookings/${TOUR_ID}/quick-booking`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: {
          fullName: "Laura Méndez",
          whatsapp: "2281234567",
          email: "laura@correo.mx",
          numberPassengers,
        },
      });

    it("cuenta personas y descuenta staff: 8 vendibles − 6 ocupados = 2; pedir 3 → 409 sin escribir", async () => {
      const { inserts } = fakeTransaction();

      const res = await quickBooking(3);

      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "Capacidad excedida. Solo quedan 2 lugares disponibles.");
      assert.equal(inserts.length, 0);
    });

    it("con lugares suficientes crea la reserva; bloquea el tour ANTES de contar e insertar", async () => {
      const { log, inserts } = fakeTransaction();

      const res = await quickBooking(2);

      assert.equal(res.statusCode, 201);
      assert.equal(res.json().data.availableSeats, 0);
      assert.deepEqual(log.slice(0, 2), ["lock:update", "count-occupied"]);
      assert.ok(log.indexOf("insert:bookings") > log.indexOf("count-occupied"));
      const booking = inserts.find((i) => i.table === "bookings")!.values;
      assert.equal(booking.status, "AWAITING_REGISTRATION");
      assert.equal(booking.totalPrice, 2000);
      // Precio pactado por lugar, para altas y bajas posteriores (2026-11-17).
      assert.equal(booking.unitPrice, 1000);
      // Auditoría: el Magic Link guarda qué operador hizo el apartado.
      const token = inserts.find((i) => i.table === "magic_tokens")!.values;
      assert.equal(token.createdByUserId, USER_A);
    });

    it("el viajero ya inscrito en el tour → 409", async () => {
      fakeTransaction({ existingTraveler: { id: "t-1" }, passengerInTour: { id: "bp-1" } });

      const res = await quickBooking(1);

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /Ya existe una reserva activa/);
    });

    it("rechaza lugares fraccionarios (400)", async () => {
      fakeTransaction();

      const res = await quickBooking(1.5);

      assert.equal(res.statusCode, 400);
    });
  });

  describe("POST /api/public/pre-booking (folleto)", () => {
    const preBooking = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/public/pre-booking",
        payload: {
          tourId: TOUR_ID,
          fullName: "Mariana Ruiz",
          whatsapp: "2299887766",
          numberPassengers: 2,
          ...payload,
        },
      });

    it("sin sesión crea la reserva con la agencia DEL TOUR, sin email, y no devuelve token ni ids", async () => {
      const { inserts } = fakeTransaction();

      const res = await preBooking({});

      assert.equal(res.statusCode, 201);
      assert.deepEqual(Object.keys(res.json()).sort(), ["message", "success"]);
      assert.ok(!res.body.includes("magic_tokens-new"));
      assert.ok(!res.body.includes("bookings-new"));

      const traveler = inserts.find((i) => i.table === "travelers")!.values;
      assert.equal(traveler.agencyId, AGENCY_A);
      assert.equal(traveler.email, null);
      const booking = inserts.find((i) => i.table === "bookings")!.values;
      assert.equal(booking.agencyId, AGENCY_A);
      assert.equal(booking.status, "AWAITING_REGISTRATION");
      const token = inserts.find((i) => i.table === "magic_tokens")!.values;
      assert.equal(token.numberPassengers, 2);
      assert.equal(token.createdByUserId, null); // sin operador: lo pidió el cliente
    });

    it("un viajero existente se reutiliza sin modificar sus datos", async () => {
      const { inserts } = fakeTransaction({ existingTraveler: { id: "t-existente" } });

      const res = await preBooking({});

      assert.equal(res.statusCode, 201);
      assert.ok(!inserts.some((i) => i.table === "travelers"));
      assert.equal(inserts.find((i) => i.table === "bookings")!.values.travelerId, "t-existente");
    });

    it("sin cupo suficiente → 409 y no escribe nada", async () => {
      const { inserts } = fakeTransaction();

      const res = await preBooking({ numberPassengers: 3 });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /Solo quedan 2 lugares/);
      assert.equal(inserts.length, 0);
    });

    it("tour cancelado por la agencia o inexistente → 404", async () => {
      fakeTransaction({ tour: { cancelledAt: "2026-11-14T10:00:00.000Z" } });

      const res = await preBooking({});

      assert.equal(res.statusCode, 404);
    });

    it("tour que ya salió → 409 sin escribir", async () => {
      const { inserts } = fakeTransaction({ tour: { departureDateTime: "2026-01-10" } });

      const res = await preBooking({});

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya no admite reservas/);
      assert.equal(inserts.length, 0);
    });

    it("valida los datos de entrada (400)", async () => {
      fakeTransaction();

      assert.equal((await preBooking({ whatsapp: "123" })).statusCode, 400);
      assert.equal((await preBooking({ numberPassengers: 0 })).statusCode, 400);
      assert.equal((await preBooking({ fullName: "A" })).statusCode, 400);
    });
  });

  describe("POST /api/bookings/:id/add-passenger", () => {
    const booking = {
      id: BOOKING_ID,
      agencyId: AGENCY_A,
      tourId: TOUR_ID,
      status: "PENDING",
      totalPrice: 2000,
      amountPaid: 0,
      paymentStatus: "PENDING",
      // Lo que relee BookingStatusService.syncStatus al final de la transacción.
      tour: { price: 1000, depositPerPerson: 500 },
      magicToken: { numberPassengers: 3 },
    };
    const addPassenger = (tourId = TOUR_ID) =>
      app.inject({
        method: "POST",
        url: `/api/bookings/${BOOKING_ID}/add-passenger`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { tourId },
      });

    it("usa la misma regla de cupo: tour lleno (8 de 8) → 409", async () => {
      fakeTransaction({
        booking,
        occupied: [{ totalPrice: 8000, magicToken: { numberPassengers: 8 } }],
      });

      const res = await addPassenger();

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /Capacidad excedida/);
    });

    it("un tourId distinto al de la reserva → 400", async () => {
      fakeTransaction({ booking });

      const res = await addPassenger(OTHER_TOUR_ID);

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /no corresponde a la reserva/);
    });

    it("con cupo agrega el lugar", async () => {
      fakeTransaction({ booking });

      const res = await addPassenger();

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().newGroupSize, 3);
    });
  });

  describe("Tours: lugares de staff", () => {
    const tourBody = {
      title: "Cascadas de Cuetzalan",
      price: 1200,
      depositPerPerson: 0,
      // Siempre en el futuro: un tour nuevo no puede salir antes de hoy (2026-11-17).
      departureDateTime: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      maxCapacity: 20,
      acceptsCash: true,
      cashInstructions: "Paga directo al abordar",
      boardingPoints: [{ location: "Plaza Central", time: "06:00" }],
    };

    it("crear con staff ≥ capacidad total → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tours",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { ...tourBody, staffCapacity: 20 },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Los lugares de staff deben ser menores a la capacidad total/);
    });

    it("crear guarda al operador de la sesión como creador y último editor (auditoría)", async () => {
      const inserted: Record<string, unknown>[] = [];
      mock.method(db, "insert", (() => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: TOUR_ID, ...values }] };
        },
      })) as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/tours",
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: tourBody,
      });

      assert.equal(res.statusCode, 201);
      assert.equal(inserted[0]!.agencyId, AGENCY_A);
      assert.equal(inserted[0]!.createdByUserId, USER_A);
      assert.equal(inserted[0]!.updatedByUserId, USER_A);
    });

    it("PATCH solo con staffCapacity se valida contra la capacidad guardada → 400", async () => {
      // updateTour lee la fila del tour con SELECT … FOR UPDATE dentro de la transacción.
      const tx = {
        select: () => chain([{ maxCapacity: 10, staffCapacity: 0, acceptsCash: true }]),
      };
      mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
        payload: { staffCapacity: 10 },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /Los lugares de staff deben ser menores/);
    });

    it("PATCH de otra agencia no encuentra el tour (404) antes de validar", async () => {
      const tx = { select: () => chain([]) };
      mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tours/${TOUR_ID}`,
        cookies: sessionCookie(app, AGENCY_B, USER_A),
        payload: { staffCapacity: 1 },
      });

      assert.equal(res.statusCode, 404);
    });
  });
});
