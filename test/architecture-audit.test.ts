import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { TourService } from "../src/modules/tours/tours.service.js";
import { AgencyBrandingService } from "../src/modules/agencies/agency-branding.service.js";
import { updateTourBodySchema } from "../src/modules/tours/tours.schema.js";
import { UPLOAD_DIRS, hasFileSignature, removeUpload } from "../src/shared/storage/uploads.js";
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

// Auditoría de arquitectura y seguridad (2026-11-15): regresiones de los hallazgos corregidos.

const TOUR_A = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
const TOUR_B = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const BOOKING_ID = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const PAYMENT_ID = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const PASSENGER_ID = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";

const PDF_BYTES = Buffer.from("%PDF-1.4\n%prueba\n", "ascii");

/** Cuerpo multipart/form-data con un solo archivo `file`. */
function multipart(fileName: string, contentType: string, content: Buffer) {
  const boundary = "----tripagent-audit";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const brochureFiles = (tourId: string) =>
  fs.existsSync(UPLOAD_DIRS.brochures)
    ? fs.readdirSync(UPLOAD_DIRS.brochures).filter((f) => f.startsWith(`tour-${tourId}-`))
    : [];

const mockTransaction = (tx: Record<string, unknown>) =>
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);

describe("Auditoría 2026-11-15", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    for (const tourId of [TOUR_A, TOUR_B]) {
      for (const f of brochureFiles(tourId)) fs.unlinkSync(path.join(UPLOAD_DIRS.brochures, f));
    }
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const cookiesA = () => sessionCookie(app, AGENCY_A, USER_A);

  describe("Folletos: ninguna agencia puede tocar el PDF de otra", () => {
    it("PATCH /tours ya no acepta `brochureUrl` (solo lo escribe la subida del folleto)", () => {
      const parsed = updateTourBodySchema.parse({
        brochureUrl: `/uploads/brochures/tour-${TOUR_B}-1.pdf`,
        removeBrochure: true,
      });
      assert.equal("brochureUrl" in parsed, false);
    });

    it("removeUpload con prefijo no borra el folleto de otro tour", async () => {
      fs.mkdirSync(UPLOAD_DIRS.brochures, { recursive: true });
      const foreign = `tour-${TOUR_B}-111.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIRS.brochures, foreign), PDF_BYTES);

      await removeUpload("brochures", `/uploads/brochures/${foreign}`, `tour-${TOUR_A}-`);
      assert.ok(fs.existsSync(path.join(UPLOAD_DIRS.brochures, foreign)), "sigue en disco");

      // Rutas fuera de la carpeta o con traversal se ignoran.
      await removeUpload("brochures", "/uploads/logos/agency-x.png");
      await removeUpload("brochures", `/uploads/brochures/../logos/${foreign}`, `tour-${TOUR_A}-`);
      assert.ok(fs.existsSync(path.join(UPLOAD_DIRS.brochures, foreign)));

      await removeUpload("brochures", `/uploads/brochures/${foreign}`, `tour-${TOUR_B}-`);
      assert.equal(fs.existsSync(path.join(UPLOAD_DIRS.brochures, foreign)), false);
    });

    it("subir a un tour ajeno → 404 sin escribir ningún archivo", async () => {
      const exists = mock.method(TourService, "existsForAgency", async () => false);
      const update = mock.method(TourService, "updateBrochureUrl", async () => {
        throw new Error("no debía llegar aquí");
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/tours/${TOUR_B}/brochure`,
        cookies: cookiesA(),
        ...multipart("folleto.pdf", "application/pdf", PDF_BYTES),
      });

      assert.equal(res.statusCode, 404);
      assert.deepEqual(exists.mock.calls[0]?.arguments, [TOUR_B, AGENCY_A]);
      assert.equal(update.mock.callCount(), 0);
      assert.equal(brochureFiles(TOUR_B).length, 0);
    });

    it("un archivo que no es PDF (aunque declare application/pdf) → 400 y no queda en disco", async () => {
      mock.method(TourService, "existsForAgency", async () => true);
      const update = mock.method(TourService, "updateBrochureUrl", async () => {
        throw new Error("no debía llegar aquí");
      });
      const before = brochureFiles(TOUR_A).length;

      const res = await app.inject({
        method: "POST",
        url: `/api/tours/${TOUR_A}/brochure`,
        cookies: cookiesA(),
        ...multipart("folleto.pdf", "application/pdf", Buffer.from("<html>no soy pdf</html>")),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(update.mock.callCount(), 0);
      assert.equal(brochureFiles(TOUR_A).length, before);
    });

    it("PDF válido → 200, guarda la ruta nueva y borra el folleto anterior del mismo tour", async () => {
      fs.mkdirSync(UPLOAD_DIRS.brochures, { recursive: true });
      const previous = `tour-${TOUR_A}-100.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIRS.brochures, previous), PDF_BYTES);
      mock.method(TourService, "existsForAgency", async () => true);
      const update = mock.method(
        TourService,
        "updateBrochureUrl",
        async (id: string, url: string) => ({
          tour: { id, brochureUrl: url },
          previousBrochureUrl: `/uploads/brochures/${previous}`,
        }),
      );

      const res = await app.inject({
        method: "POST",
        url: `/api/tours/${TOUR_A}/brochure`,
        cookies: cookiesA(),
        ...multipart("folleto.pdf", "application/pdf", PDF_BYTES),
      });

      assert.equal(res.statusCode, 200);
      const savedUrl = String(update.mock.calls[0]?.arguments[1]);
      assert.match(savedUrl, new RegExp(`^/uploads/brochures/tour-${TOUR_A}-\\d+\\.pdf$`));
      assert.ok(fs.existsSync(path.join(UPLOAD_DIRS.brochures, path.basename(savedUrl))));
      assert.equal(fs.existsSync(path.join(UPLOAD_DIRS.brochures, previous)), false);
    });
  });

  describe("Firma real de los archivos (magic bytes)", () => {
    it("hasFileSignature distingue PDF, PNG y JPEG de un contenido falso", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tripagent-sig-"));
      const write = (name: string, bytes: Buffer) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, bytes);
        return p;
      };
      try {
        assert.equal(await hasFileSignature(write("a.pdf", PDF_BYTES), "pdf"), true);
        assert.equal(
          await hasFileSignature(
            write("b.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
            "png",
          ),
          true,
        );
        assert.equal(
          await hasFileSignature(write("c.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg"),
          true,
        );
        assert.equal(await hasFileSignature(write("d.png", Buffer.from("<svg/>")), "png"), false);
        assert.equal(await hasFileSignature(write("e.pdf", Buffer.from("%PD")), "pdf"), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("POST /agencies/logo con image/png pero contenido que no es PNG → 400 sin tocar la base", async () => {
      const setPath = mock.method(AgencyBrandingService, "setLogoPath", async () => ({
        previousLogoPath: null,
      }));
      const res = await app.inject({
        method: "POST",
        url: "/api/agencies/logo",
        // Agencia B: agency-branding.test.ts cuenta en paralelo los archivos `agency-A-*`.
        cookies: sessionCookie(app, AGENCY_B, USER_A),
        ...multipart("logo.png", "image/png", Buffer.from("<svg onload=alert(1)/>")),
      });
      assert.equal(res.statusCode, 400);
      assert.equal(setPath.mock.callCount(), 0);
    });
  });

  describe("Endpoints sin consumidores que se saltaban controles", () => {
    it("POST /api/bookings (registro con sesión sin aviso de privacidad) ya no existe", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/bookings",
        cookies: cookiesA(),
        payload: {},
      });
      assert.equal(res.statusCode, 404);
    });

    it("POST /api/agencies (crear agencias con cualquier suscripción) ya no existe", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agencies",
        cookies: cookiesA(),
        payload: { name: "Otra", subscriptionStatus: "active" },
      });
      assert.equal(res.statusCode, 404);
    });

    // OBS-024 (2026-11-17): endpoints sin consumidor en el front, eliminados con sus servicios.
    for (const [method, url, payload] of [
      ["GET", `/api/agencies/${AGENCY_A}`, undefined],
      ["PATCH", `/api/bookings/${BOOKING_ID}/cancel`, { penaltyPercentage: 50 }],
      ["GET", "/api/travelers/7b2a0c1e-3f4d-4e5a-9b6c-1d2e3f4a5b6c", undefined],
      ["POST", "/api/travelers", { fullName: "Ana Ruiz", emergencyContactName: "Luis" }],
      ["POST", "/api/vehicles", { name: "Unidad propia", layoutMap: [["1", "AISLE", "2"]] }],
    ] as const) {
      it(`${method} ${url.replace(/[0-9a-f-]{36}/, ":id")} ya no existe → 404`, async () => {
        const res = await app.inject({
          method,
          url,
          cookies: cookiesA(),
          ...(payload ? { payload } : {}),
        });
        assert.equal(res.statusCode, 404);
      });
    }
  });

  describe("Pagos: candado de la reserva y anulación única", () => {
    function ledgerTx(
      entries: { id: string; type: string; amount: number; referenceInfo?: string }[],
    ) {
      const forUpdate = mock.fn();
      const insert = mock.fn(() => chain([{ id: "nuevo" }]));
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: (mode: string) => {
                forUpdate(mode);
                return Promise.resolve([{ id: BOOKING_ID }]);
              },
            }),
          }),
        }),
        query: {
          // Tour PRÓXIMO: fuera del Modo Auditoría.
          bookings: {
            findFirst: async () => ({
              id: BOOKING_ID,
              tour: { departureDateTime: "2099-01-10", returnDate: null, cancelledAt: null },
            }),
          },
          payments: {
            findFirst: async () => ({ ...entries[0], agencyId: AGENCY_A, bookingId: BOOKING_ID }),
            findMany: async () => entries,
          },
        },
        insert,
        update: () => chain(undefined),
      };
      mockTransaction(tx);
      return { forUpdate, insert };
    }

    const voidPayment = () =>
      app.inject({
        method: "POST",
        url: `/api/payments/${BOOKING_ID}/payments/${PAYMENT_ID}/void`,
        cookies: cookiesA(),
        payload: { reason: "Error de captura" },
      });

    it("anular por segunda vez el mismo abono → 409 sin insertar otro contra-asiento", async () => {
      const { forUpdate, insert } = ledgerTx([
        { id: PAYMENT_ID, type: "PAYMENT", amount: 500 },
        {
          id: "void-1",
          type: "REFUND",
          amount: -500,
          referenceInfo: `Anulación: Error de captura (Ref: ${PAYMENT_ID})`,
        },
      ]);

      const res = await voidPayment();

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /ya fue anulado/);
      assert.deepEqual(forUpdate.mock.calls[0]?.arguments, ["update"]);
      assert.equal(insert.mock.callCount(), 0);
    });

    it("reserva de otra agencia → 404 desde el candado, sin leer ni escribir pagos", async () => {
      const findMany = mock.fn(async () => []);
      const insert = mock.fn();
      mockTransaction({
        select: () => chain([]), // el SELECT … FOR UPDATE filtrado por agencia no encuentra nada
        query: { payments: { findFirst: findMany, findMany } },
        insert,
      });

      const res = await voidPayment();

      assert.equal(res.statusCode, 404);
      assert.equal(findMany.mock.callCount(), 0);
      assert.equal(insert.mock.callCount(), 0);
    });
  });

  describe("Asientos: solo pasajeros activos de reservas no canceladas", () => {
    it("asignar asiento a un pasajero cuya reserva está cancelada → 404 sin asignar", async () => {
      const updates: Record<string, unknown>[] = [];
      let selectCall = 0;
      mockTransaction({
        query: {
          tours: {
            findFirst: async ({ where }: { where?: SQL }) =>
              [{ id: TOUR_A, agencyId: AGENCY_A, deletedAt: null }].find((t) =>
                rowMatches(where, t),
              ) && {
                id: TOUR_A,
                price: 1000,
                depositPerPerson: 0,
                staffCapacity: 0,
                vehicle: null,
              },
          },
          bookingPassengers: { findFirst: async () => undefined },
        },
        // 1) candado del tour, 2) reservas del tour (la única está cancelada).
        select: () =>
          chain(selectCall++ === 0 ? [{ id: TOUR_A }] : [{ id: BOOKING_ID, status: "CANCELLED" }]),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            updates.push(values);
            return chain([]);
          },
        }),
        delete: () => chain(undefined),
        insert: () => chain(undefined),
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/seats/${TOUR_A}/seats/5`,
        cookies: cookiesA(),
        payload: { status: "ASSIGNED", passengerId: PASSENGER_ID },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(
        updates.some((u) => u.seatLabel === "5"),
        false,
        "no se asigna la etiqueta a nadie",
      );
    });

    it("una etiqueta de más de 10 caracteres es 400 (antes un 500 de la base)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/seats/${TOUR_A}/seats/${"X".repeat(11)}`,
        cookies: cookiesA(),
        payload: { status: "BLOCKED" },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe("Tours ajenos: 404 (antes 500 con el texto del error)", () => {
    it("GET /dashboards/:id de otra agencia → 404", async () => {
      mock.method(db.query.tours, "findFirst", (async () => undefined) as never);
      const res = await app.inject({
        method: "GET",
        url: `/api/dashboards/${TOUR_B}`,
        cookies: cookiesA(),
      });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: "Tour no encontrado" });
    });

    it("GET /manifest/:id de otra agencia → 404", async () => {
      mock.method(db.query.tours, "findFirst", (async () => undefined) as never);
      const res = await app.inject({
        method: "GET",
        url: `/api/manifest/${TOUR_B}/`,
        cookies: cookiesA(),
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe("Dashboard: equivalente en MXN de un tour en USD", () => {
    it("un reembolso RESTA del equivalente (collectedAmount ya se guarda negativo)", async () => {
      mock.method(db.query.tours, "findFirst", (async () => ({
        id: TOUR_A,
        agencyId: AGENCY_A,
        title: "Disney",
        price: 1000,
        depositPerPerson: 0,
        maxCapacity: 20,
        staffCapacity: 0,
        currency: "USD",
        transportModality: "TRANSPORT_INCLUDED",
        departureDateTime: "2027-01-15",
        vehicle: null,
        agency: { name: "Viajes" },
      })) as never);
      let call = 0;
      mock.method(db.query.bookings, "findMany", (async () =>
        call++ === 0
          ? [
              {
                id: BOOKING_ID,
                status: "PENDING",
                paymentStatus: "PARTIAL",
                totalPrice: 1000,
                amountPaid: 100,
                createdAt: "2026-11-10T00:00:00.000Z",
                magicToken: { numberPassengers: 1, token: "tok" },
                passengers: [
                  {
                    isTitular: true,
                    status: "ACTIVE",
                    seatLabel: null,
                    boardingPoint: null,
                    traveler: {
                      id: "t1",
                      fullName: "Titular",
                      whatsappPhone: "2281234567",
                      emergencyContactPhone: "2287654321",
                    },
                  },
                ],
                payments: [
                  {
                    id: "p1",
                    type: "PAYMENT",
                    method: "CASH",
                    amount: 200,
                    collectedAmount: 4000,
                    collectedCurrency: "MXN",
                    exchangeRate: 20,
                    createdAt: "2026-11-10T00:00:00.000Z",
                  },
                  {
                    id: "p2",
                    type: "REFUND",
                    method: "CASH",
                    amount: -100,
                    collectedAmount: -2000,
                    collectedCurrency: "MXN",
                    exchangeRate: 20,
                    referenceInfo: `Anulación: x (Ref: ${PAYMENT_ID})`,
                    createdAt: "2026-11-11T00:00:00.000Z",
                  },
                ],
              },
            ]
          : []) as never);

      const res = await app.inject({
        method: "GET",
        url: `/api/dashboards/${TOUR_A}`,
        cookies: cookiesA(),
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().travelers[0].equivalentMXN, 2000); // 4000 − 2000 (antes 6000)
    });
  });
});
