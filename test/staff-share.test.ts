import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  STAFF_SHARE_TOKEN_LENGTH,
  STAFF_SHARE_UNAVAILABLE_MESSAGE,
  describeStaffShare,
  generateStaffShareToken,
  getStaffShareExpiresAt,
  isStaffShareExpired,
} from "../src/shared/utils/staff-share.util.js";
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

// Enlace de staff (regla 26, 2026-11-22): croquis y pasajeros de solo lectura para el coordinador.

const TOUR_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const VALID_TOKEN = "A".repeat(STAFF_SHARE_TOKEN_LENGTH);
const SECRET_WHATSAPP = "+522281234567";
const SECRET_EMAIL = "mariana.secreta@example.com";
const SECRET_EMERGENCY = "+522289999999";
const SECRET_MAGIC_TOKEN = "magic-token-no-publicar";

const SPRINTER_LAYOUT = [
  [{ type: "DRIVER" }, null, { type: "SEAT", label: "1", kind: "STAFF" }],
  ["2", "AISLE", "3"],
  ["10", "AISLE", "11"],
];

/** Fila del tour como la devolvería la consulta pública (con columnas de más para la prueba). */
const publicTourRow = (overrides: Record<string, unknown> = {}) => ({
  id: TOUR_ID,
  agencyId: AGENCY_A,
  staffShareToken: VALID_TOKEN,
  deletedAt: null,
  cancelledAt: null,
  title: "Huasteca Potosina",
  price: 1000,
  depositPerPerson: 500,
  departureDateTime: "2099-03-10",
  returnDate: "2099-03-12",
  boardingPoints: [
    { id: "bp-1", location: "Plaza Xalapa", time: "06:00" },
    { id: "bp-2", location: "Las Ánimas", time: "06:30" },
  ],
  agency: {
    name: "Viajes Xalapa",
    logoPath: "/uploads/logos/a.png",
    isActive: true,
    deletedAt: null,
  },
  vehicle: { name: "Sprinter 20", layoutMap: SPRINTER_LAYOUT },
  ...overrides,
});

const traveler = (fullName: string) => ({
  fullName,
  // Columnas que la consulta NO pide: si llegaran, la proyección no debe publicarlas.
  whatsappPhone: SECRET_WHATSAPP,
  email: SECRET_EMAIL,
  emergencyContactPhone: SECRET_EMERGENCY,
  birthDate: "1990-05-05",
});

const bookingRows = () => [
  {
    id: "booking-1",
    totalPrice: 2000,
    amountPaid: 1000, // anticipo $500 × 2 cubierto
    magicToken: { numberPassengers: 2, token: SECRET_MAGIC_TOKEN },
    passengers: [
      {
        isTitular: true,
        seatLabel: "10",
        boardingPoint: "bp-1",
        passengerType: "ADULT",
        traveler: traveler("Mariana Ruiz"),
      },
      {
        isTitular: false,
        seatLabel: "2",
        boardingPoint: "Las Ánimas (06:30)",
        passengerType: "CHILD",
        traveler: traveler("Diego Ruiz"),
      },
    ],
  },
  {
    id: "booking-2",
    totalPrice: 1000,
    amountPaid: 0, // anticipo sin cubrir
    magicToken: { numberPassengers: 1, token: SECRET_MAGIC_TOKEN },
    passengers: [
      {
        isTitular: true,
        seatLabel: null,
        boardingPoint: null,
        passengerType: "ADULT",
        traveler: traveler("Ana Beltrán"),
      },
    ],
  },
];

/** Simula la consulta pública evaluando el WHERE real (token, sin borrar, sin cancelar). */
function mockPublicQueries(tourRow: Record<string, unknown> | null = publicTourRow()) {
  const findFirst = mock.method(db.query.tours, "findFirst", (async (args: { where: SQL }) =>
    tourRow && rowMatches(args.where, tourRow) ? tourRow : undefined) as never);
  mock.method(db, "select", (() => chain([{ seatLabel: "3" }, { seatLabel: "11" }])) as never);
  mock.method(db.query.bookings, "findMany", (async () => bookingRows()) as never);
  return { findFirst };
}

describe("getStaffShareExpiresAt: 24 h después del último día del tour (CDMX)", () => {
  it("con regreso: fin del día siguiente al regreso en CDMX (UTC−6)", () => {
    assert.equal(
      getStaffShareExpiresAt("2026-12-10", "2026-12-12").toISOString(),
      "2026-12-14T05:59:59.999Z",
    );
  });

  it("sin regreso (viaje de un día): fin del día siguiente a la salida", () => {
    assert.equal(
      getStaffShareExpiresAt("2026-12-10", null).toISOString(),
      "2026-12-12T05:59:59.999Z",
    );
  });

  it("regreso anterior a la salida: se ignora y cuenta la salida", () => {
    assert.equal(
      getStaffShareExpiresAt("2026-12-10", "2026-12-01").toISOString(),
      "2026-12-12T05:59:59.999Z",
    );
  });

  it("cruza de mes y de año", () => {
    assert.equal(
      getStaffShareExpiresAt("2026-12-30", "2026-12-31").toISOString(),
      "2027-01-02T05:59:59.999Z",
    );
  });

  it("borde de medianoche en CDMX: vigente a las 23:59:59.999 y vencido 1 ms después", () => {
    const expiresAt = getStaffShareExpiresAt("2026-12-10", null);
    assert.equal(isStaffShareExpired(expiresAt, new Date("2026-12-12T05:59:59.999Z")), false);
    assert.equal(isStaffShareExpired(expiresAt, new Date("2026-12-12T06:00:00.000Z")), true);
  });

  it("describeStaffShare: null sin token; con token, vencimiento e isExpired", () => {
    const tour = { staffShareToken: null, departureDateTime: "2026-12-10", returnDate: null };
    assert.equal(describeStaffShare(tour), null);
    assert.deepEqual(
      describeStaffShare(
        { ...tour, staffShareToken: VALID_TOKEN },
        new Date("2026-12-13T00:00:00.000Z"),
      ),
      { token: VALID_TOKEN, expiresAt: "2026-12-12T05:59:59.999Z", isExpired: true },
    );
  });

  it("el token es base64url de 32 caracteres y distinto en cada llamada", () => {
    const first = generateStaffShareToken();
    assert.match(first, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(first, generateStaffShareToken());
  });
});

describe("Enlace de staff: endpoints autenticados", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  /** Transacción falsa: el SELECT … FOR UPDATE devuelve `tourRow` y se registra cada UPDATE. */
  function mockTransaction(tourRow: Record<string, unknown> | undefined) {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      select: () => chain(tourRow ? [tourRow] : []),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return chain(undefined);
        },
      }),
    };
    mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
    return { updates };
  }

  const upcomingTour = { departureDateTime: "2099-03-10", returnDate: null, cancelledAt: null };

  const createShare = (agencyId = AGENCY_A) =>
    app.inject({
      method: "POST",
      url: `/api/tours/${TOUR_ID}/staff-share`,
      cookies: sessionCookie(app, agencyId, USER_A),
    });

  it("POST crea el token, guarda al autor y responde { data: { token, expiresAt } }", async () => {
    const { updates } = mockTransaction(upcomingTour);

    const res = await createShare();

    assert.equal(res.statusCode, 200);
    const { data } = res.json();
    assert.match(data.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(data.expiresAt, "2099-03-12T05:59:59.999Z");
    assert.equal(updates[0]?.staffShareToken, data.token);
    assert.equal(updates[0]?.staffShareTokenCreatedByUserId, USER_A);
    assert.equal(updates[0]?.updatedByUserId, USER_A);
  });

  it("regenerar cambia el token y el anterior responde 404 en la ruta pública", async () => {
    const { updates } = mockTransaction(upcomingTour);
    const first = (await createShare()).json().data.token as string;
    const second = (await createShare()).json().data.token as string;
    assert.notEqual(first, second);
    assert.equal(updates.length, 2);

    // La base solo conserva el último token.
    mockPublicQueries(publicTourRow({ staffShareToken: second }));
    const oldRes = await app.inject({ method: "GET", url: `/api/public/staff-share/${first}` });
    const newRes = await app.inject({ method: "GET", url: `/api/public/staff-share/${second}` });
    assert.equal(oldRes.statusCode, 404);
    assert.equal(oldRes.json().error, STAFF_SHARE_UNAVAILABLE_MESSAGE);
    assert.equal(newRes.statusCode, 200);
  });

  it("POST de un tour ajeno o inexistente → 404 sin escribir", async () => {
    const { updates } = mockTransaction(undefined);

    const res = await createShare(AGENCY_B);

    assert.equal(res.statusCode, 404);
    assert.equal(updates.length, 0);
  });

  it("POST en Modo Auditoría (FINALIZADO o CANCELADO) → 409 sin escribir", async () => {
    for (const tour of [
      { departureDateTime: "2020-01-01", returnDate: null, cancelledAt: null },
      { ...upcomingTour, cancelledAt: "2026-11-20T10:00:00.000Z" },
    ]) {
      const { updates } = mockTransaction(tour);
      const res = await createShare();
      assert.equal(res.statusCode, 409);
      assert.equal(updates.length, 0);
      mock.restoreAll();
    }
  });

  it("DELETE desactiva el enlace (token = null) y responde { data: { token: null } }", async () => {
    const sets: Record<string, unknown>[] = [];
    mock.method(db, "update", (() => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return chain([{ id: TOUR_ID }]);
      },
    })) as never);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/tours/${TOUR_ID}/staff-share`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { data: { token: null } });
    assert.equal(sets[0]?.staffShareToken, null);
  });

  it("DELETE de un tour ajeno → 404", async () => {
    mock.method(db, "update", (() => ({ set: () => chain([]) })) as never);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/tours/${TOUR_ID}/staff-share`,
      cookies: sessionCookie(app, AGENCY_B, USER_A),
    });

    assert.equal(res.statusCode, 404);
  });

  it("sin sesión → 401", async () => {
    const res = await app.inject({ method: "POST", url: `/api/tours/${TOUR_ID}/staff-share` });
    assert.equal(res.statusCode, 401);
  });

  it("dashboard: staffShare null sin token y { token, expiresAt, isExpired } con token", async () => {
    const tour = {
      id: TOUR_ID,
      agencyId: AGENCY_A,
      title: "Huasteca Potosina",
      price: 1000,
      depositPerPerson: 0,
      maxCapacity: 20,
      staffCapacity: 1,
      currency: "MXN",
      transportModality: "TRANSPORT_INCLUDED",
      departureDateTime: "2099-03-10",
      returnDate: null,
      cancelledAt: null,
      staffShareToken: null as string | null,
      vehicle: null,
      agency: { name: "Viajes Xalapa" },
    };
    mock.method(db.query.tours, "findFirst", (async () => tour) as never);
    mock.method(db.query.bookings, "findMany", (async () => []) as never);
    const getDashboard = () =>
      app.inject({
        method: "GET",
        url: `/api/dashboards/${TOUR_ID}`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });

    assert.equal((await getDashboard()).json().staffShare, null);

    tour.staffShareToken = VALID_TOKEN;
    const body = (await getDashboard()).json();
    assert.deepEqual(body.staffShare, {
      token: VALID_TOKEN,
      expiresAt: "2099-03-12T05:59:59.999Z",
      isExpired: false,
    });
    // La forma del dashboard no cambia: sigue sin envoltorio `data`.
    assert.equal(body.id, TOUR_ID);
  });
});

describe("Enlace de staff: Modo Solo Lectura por suscripción", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp({ isAgencyReadOnly: async () => true });
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("POST y DELETE → 402 SUBSCRIPTION_READ_ONLY sin llegar al servicio", async () => {
    const transaction = mock.method(db, "transaction", (async () => {
      throw new Error("no debería llamarse");
    }) as never);
    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/tours/${TOUR_ID}/staff-share`,
        cookies: sessionCookie(app, AGENCY_A, USER_A),
      });
      assert.equal(res.statusCode, 402);
      assert.equal(res.json().code, "SUBSCRIPTION_READ_ONLY");
    }
    assert.equal(transaction.mock.callCount(), 0);
  });

  it("la ruta pública sigue funcionando (es una consulta)", async () => {
    mockPublicQueries();
    const res = await app.inject({ method: "GET", url: `/api/public/staff-share/${VALID_TOKEN}` });
    assert.equal(res.statusCode, 200);
  });
});

describe("Enlace de staff: ruta pública", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const getPublic = (token: string) =>
    app.inject({ method: "GET", url: `/api/public/staff-share/${token}` });

  it("responde la forma exacta: asientos en orden natural, códigos P1..Pn y derecho a asiento", async () => {
    mockPublicQueries();

    const res = await getPublic(VALID_TOKEN);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      data: {
        tour: {
          title: "Huasteca Potosina",
          departureDate: "2099-03-10",
          returnDate: "2099-03-12",
          temporalStatus: "PRÓXIMO",
        },
        agency: { name: "Viajes Xalapa", logoPath: "/uploads/logos/a.png" },
        expiresAt: "2099-03-14T05:59:59.999Z",
        vehicle: {
          name: "Sprinter 20",
          layoutMap: SPRINTER_LAYOUT,
          capacity: { total: 5, passenger: 4, staff: 1 },
        },
        blockedSeats: ["3", "11"],
        boardingPoints: [
          { code: "P1", location: "Plaza Xalapa", time: "06:00" },
          { code: "P2", location: "Las Ánimas", time: "06:30" },
        ],
        passengers: [
          {
            seatLabel: "2",
            fullName: "Diego Ruiz",
            passengerType: "CHILD",
            isTitular: false,
            boardingPointCode: "P2",
            seatRightStatus: "CONFIRMED",
          },
          {
            seatLabel: "10",
            fullName: "Mariana Ruiz",
            passengerType: "ADULT",
            isTitular: true,
            boardingPointCode: "P1",
            seatRightStatus: "CONFIRMED",
          },
          {
            seatLabel: null,
            fullName: "Ana Beltrán",
            passengerType: "ADULT",
            isTitular: true,
            boardingPointCode: null,
            seatRightStatus: "PENDING_DEPOSIT",
          },
        ],
      },
    });
  });

  it("cabeceras: Cache-Control no-store y X-Robots-Tag noindex (también en el 404)", async () => {
    mockPublicQueries();
    for (const token of [VALID_TOKEN, "B".repeat(STAFF_SHARE_TOKEN_LENGTH)]) {
      const res = await getPublic(token);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.match(String(res.headers["x-robots-tag"]), /noindex/);
    }
  });

  it("privacidad (LFPDPPP): sin montos, contactos, fechas de nacimiento, ids ni magic tokens", async () => {
    mockPublicQueries();

    const res = await getPublic(VALID_TOKEN);
    const raw = res.body;

    const keys = new Set<string>();
    const collectKeys = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collectKeys);
      if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          collectKeys(nested);
        }
      }
    };
    collectKeys(res.json());

    const forbidden = [
      "id",
      "agencyId",
      "travelerId",
      "bookingId",
      "price",
      "totalPrice",
      "amountPaid",
      "balance",
      "depositPerPerson",
      "requiredDeposit",
      "phone",
      "whatsapp",
      "whatsappPhone",
      "email",
      "emergencyContactName",
      "emergencyContactPhone",
      "birthDate",
      "magicToken",
      "staffShareToken",
    ];
    for (const key of forbidden) assert.equal(keys.has(key), false, `no debe incluir "${key}"`);
    for (const secret of [
      SECRET_WHATSAPP,
      SECRET_EMAIL,
      SECRET_EMERGENCY,
      SECRET_MAGIC_TOKEN,
      "1990-05-05",
      "booking-1",
      TOUR_ID,
      AGENCY_A,
      VALID_TOKEN,
    ]) {
      assert.equal(raw.includes(secret), false, `no debe incluir ${secret}`);
    }
  });

  it("404 con el mismo mensaje: inexistente, vencido, cancelado, borrado y agencia suspendida", async () => {
    const cases: [string, Record<string, unknown> | null][] = [
      ["inexistente", null],
      ["vencido", publicTourRow({ departureDateTime: "2020-01-01", returnDate: null })],
      ["cancelado", publicTourRow({ cancelledAt: "2026-11-20T10:00:00.000Z" })],
      ["borrado", publicTourRow({ deletedAt: "2026-11-20T10:00:00.000Z" })],
      [
        "agencia suspendida",
        publicTourRow({
          agency: { name: "X", logoPath: null, isActive: false, deletedAt: null },
        }),
      ],
    ];
    for (const [label, row] of cases) {
      mockPublicQueries(row);
      const res = await getPublic(VALID_TOKEN);
      assert.equal(res.statusCode, 404, label);
      assert.deepEqual(res.json(), { error: STAFF_SHARE_UNAVAILABLE_MESSAGE }, label);
      mock.restoreAll();
    }
  });

  it("formato inválido → el mismo 404, sin consultar la base", async () => {
    const { findFirst } = mockPublicQueries();
    for (const token of ["corto", `${"A".repeat(31)}*`, "A".repeat(33)]) {
      const res = await getPublic(encodeURIComponent(token));
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: STAFF_SHARE_UNAVAILABLE_MESSAGE });
    }
    assert.equal(findFirst.mock.callCount(), 0);
  });

  it("límite de intentos: la ruta declara 120 cada 10 minutos por IP del visitante", async () => {
    const { RATE_LIMITS } = await import("../src/shared/security/rate-limits.js");
    assert.equal(RATE_LIMITS.staffShare.max, 120);
    assert.equal(RATE_LIMITS.staffShare.timeWindow, 10 * 60 * 1000);
    assert.equal(typeof RATE_LIMITS.staffShare.keyGenerator, "function");
  });
});
