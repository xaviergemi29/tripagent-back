import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { AGENCY_A, createTestApp, rowMatches, type TestApp } from "./helpers.js";

const TOUR_ID = "33333333-3333-4333-8333-333333333333";
const DELETED_TOUR_ID = "33333333-3333-4333-8333-333333333334";
const INACTIVE_TOUR_ID = "33333333-3333-4333-8333-333333333335";
const MISSING_TOUR_ID = "33333333-3333-4333-8333-333333333336";

// Filas "completas" tal como están en la base de datos.
const agencyRow = {
  id: AGENCY_A,
  name: "Agencia Prueba",
  phone: "5512345678",
  logoUrl: "https://cdn.test/logo.png",
  email: "privado@agencia.test",
  subscriptionStatus: "active",
  trialEndsAt: null,
  bankName: "Banco Secreto",
  bankAccountHolder: "Titular Secreto",
  clabeNumber: "012345678901234567",
  address: "Calle Privada 123",
  cardNumber: "4111111111111111",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

const tourRow = {
  id: TOUR_ID,
  agencyId: AGENCY_A,
  vehicleId: null,
  createdByUserId: null,
  updatedByUserId: null,
  destinationType: "NATIONAL",
  title: "Tour de Prueba",
  description: "",
  transportModality: "TRANSPORT_INCLUDED",
  price: 1500,
  currency: "MXN",
  depositPerPerson: 500,
  departureDateTime: "2026-12-20",
  returnDate: "2026-12-21",
  maxCapacity: 20,
  isActive: true,
  acceptsBankTransfer: true,
  acceptsCreditCard: false,
  paymentLink: null,
  postPaymentInstructions: "",
  acceptsCash: false,
  cashInstructions: null,
  boardingPoints: [{ id: "bp-1", time: "07:00", location: "Plaza Central" }],
  brochureUrl: "/uploads/brochures/tour.pdf",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

const toursTable = [
  tourRow,
  { ...tourRow, id: DELETED_TOUR_ID, deletedAt: "2026-02-01T00:00:00Z" },
  { ...tourRow, id: INACTIVE_TOUR_ID, isActive: false },
];

type Columns = Record<string, boolean> | undefined;
const project = (row: Record<string, unknown>, columns: Columns) =>
  columns ? Object.fromEntries(Object.keys(columns).map((k) => [k, row[k]])) : { ...row };

/** Simula db.query.tours.findFirst: evalúa el `where` y aplica `columns` / `with.agency`. */
function fakeToursFindFirst(opts: {
  where?: SQL;
  columns?: Columns;
  with?: { agency?: true | { columns?: Columns } };
}) {
  const row = toursTable.find((t) => rowMatches(opts.where, t));
  if (!row) return Promise.resolve(undefined);

  const result: Record<string, unknown> = project(row, opts.columns);
  const agencyOpt = opts.with?.agency;
  if (agencyOpt) {
    result.agency = project(agencyRow, agencyOpt === true ? undefined : agencyOpt.columns);
  }
  return Promise.resolve(result);
}

// Campos que la landing /p/[id] del front lee del tour.
const FIELDS_USED_BY_BROCHURE = [
  "id",
  "title",
  "currency",
  "transportModality",
  "price",
  "depositPerPerson",
  "departureDateTime",
  "returnDate",
  "brochureUrl",
  "boardingPoints",
];

const SENSITIVE_VALUES = [
  agencyRow.clabeNumber,
  agencyRow.cardNumber,
  agencyRow.bankName,
  agencyRow.bankAccountHolder,
  agencyRow.email,
  agencyRow.address,
];

const brochureUrl = (id: string) => `/api/tour-brochure/public/tours/${id}`;

describe("GET /api/tour-brochure/public/tours/:id (folleto público)", () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("es accesible sin autenticación y entrega lo que necesita el folleto", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(TOUR_ID) });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    for (const field of FIELDS_USED_BY_BROCHURE) {
      assert.ok(field in body, `falta el campo ${field}`);
    }
    assert.deepEqual(body.agency, { name: agencyRow.name, phone: agencyRow.phone });
  });

  it("no expone datos bancarios ni privados de la agencia", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(TOUR_ID) });

    assert.equal(res.statusCode, 200);
    for (const secret of SENSITIVE_VALUES) {
      assert.ok(!res.body.includes(secret), `la respuesta pública contiene "${secret}"`);
    }
    for (const key of ["bankName", "bankAccountHolder", "clabeNumber", "cardNumber", "email"]) {
      assert.ok(!(key in res.json().agency), `agency.${key} no debe ser público`);
    }
  });

  it("no expone identificadores internos ni configuración interna del tour", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(TOUR_ID) });
    const body = res.json();

    for (const key of ["agencyId", "vehicleId", "createdByUserId", "deletedAt"]) {
      assert.ok(!(key in body), `${key} no debe ser público`);
    }
  });

  it("tour inexistente: 404", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(MISSING_TOUR_ID) });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "Tour no encontrado" });
  });

  it("tour eliminado (deletedAt): no disponible públicamente (404)", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(DELETED_TOUR_ID) });

    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes(tourRow.title));
  });

  it("tour inactivo (isActive=false): no disponible públicamente (404)", async () => {
    mock.method(db.query.tours, "findFirst", fakeToursFindFirst as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(INACTIVE_TOUR_ID) });

    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes(tourRow.title));
  });

  it("error inesperado: 500 genérico, sin disfrazarlo de 404 ni filtrar el mensaje interno", async () => {
    mock.method(db.query.tours, "findFirst", (() =>
      Promise.reject(new Error("connection terminated: secreto-interno"))) as never);

    const res = await app.inject({ method: "GET", url: brochureUrl(TOUR_ID) });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "Error interno del servidor" });
  });
});
