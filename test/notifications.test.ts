import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../src/db/index.js";
import {
  toNotificationBooking,
  type NotificationBookingRow,
} from "../src/modules/notifications/notifications.service.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

const NOTIFICATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const dialect = new PgDialect();

/** Fila del LEFT JOIN de una reserva viva: anticipo $500 × 2 lugares = $1,000. */
const liveBookingRow: NotificationBookingRow = {
  bookingStatus: "AWAITING_REGISTRATION",
  bookingTotalPrice: 3000,
  bookingAmountPaid: 0,
  tourPrice: 1500,
  tourDepositPerPerson: 500,
  tourCurrency: "MXN",
  titularWhatsappPhone: "+522281234567",
  magicToken: "abc123token",
  magicTokenPassengers: 2,
};

/** Fila del LEFT JOIN cuando la reserva no se trajo (borrada, inexistente o ajena). */
const missingBookingRow: NotificationBookingRow = {
  bookingStatus: null,
  bookingTotalPrice: null,
  bookingAmountPaid: null,
  tourPrice: null,
  tourDepositPerPerson: null,
  tourCurrency: null,
  titularWhatsappPhone: null,
  magicToken: null,
  magicTokenPassengers: null,
};

interface RecordedSelect {
  joins: { table: unknown; on: SQL }[];
  where?: SQL;
  limit?: number;
}

/**
 * `db.select(...)` grabadora: la 1.ª llamada es la lista (con sus LEFT JOIN) y resuelve `rows`; la
 * 2.ª, el conteo de no leídas.
 */
function fakeSelects(rows: unknown[], unreadCount = 0) {
  const recorded: RecordedSelect[] = [];
  mock.method(db, "select", (() => {
    const call: RecordedSelect = { joins: [] };
    const result = recorded.length === 0 ? rows : [{ value: unreadCount }];
    recorded.push(call);
    const builder: Record<string, unknown> = {
      from: () => builder,
      leftJoin: (table: unknown, on: SQL) => {
        call.joins.push({ table, on });
        return builder;
      },
      where: (where: SQL) => {
        call.where = where;
        return builder;
      },
      orderBy: () => builder,
      limit: (limit: number) => {
        call.limit = limit;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  }) as never);
  return recorded;
}

/** SQL de una condición de JOIN con sus parámetros sustituidos (para buscar la agencia). */
function renderJoin(on: SQL): string {
  const { sql, params } = dialect.sqlToQuery(on);
  return sql.replace(/\$(\d+)/g, (_, i: string) => `'${String(params[Number(i) - 1])}'`);
}

/** `db.update(...).set(...).where(...).returning()` que guarda el set y el where. */
function fakeUpdate(returned: unknown[]) {
  const calls: { values: Record<string, unknown>; where: SQL | undefined }[] = [];
  mock.method(db, "update", (() => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: SQL) => {
        calls.push({ values, where });
        return { returning: async () => returned };
      },
    }),
  })) as never);
  return calls;
}

describe("Notificaciones in-app (/api/notifications)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("sin sesión → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications" });
    assert.equal(res.statusCode, 401);
  });

  it("GET devuelve las últimas 20 de la agencia de la sesión y el conteo de no leídas", async () => {
    const recorded = fakeSelects(
      [{ id: NOTIFICATION_ID, type: "PRE_BOOKING", isRead: false, ...liveBookingRow }],
      3,
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.unreadCount, 3);
    assert.equal(res.json().data.items.length, 1);
    assert.equal(recorded[0]!.limit, 20);
    assert.ok(rowMatches(recorded[0]!.where, { agencyId: AGENCY_A }));
    assert.ok(!rowMatches(recorded[0]!.where, { agencyId: AGENCY_B }));
    assert.ok(rowMatches(recorded[1]!.where, { agencyId: AGENCY_A, isRead: false }));
  });

  it("cada aviso trae `booking` vivo (estado, WhatsApp del titular, Magic Link, anticipo, moneda)", async () => {
    fakeSelects([
      {
        id: NOTIFICATION_ID,
        tourId: "t1",
        bookingId: "b1",
        type: "PRE_BOOKING",
        travelerName: "Mariana Ruiz",
        tourTitle: "Zacatlán",
        seatsCount: 2,
        isRead: false,
        createdAt: "2026-11-22T10:00:00.000Z",
        ...liveBookingRow,
        bookingAmountPaid: 300,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.items[0], {
      id: NOTIFICATION_ID,
      tourId: "t1",
      bookingId: "b1",
      type: "PRE_BOOKING",
      travelerName: "Mariana Ruiz",
      tourTitle: "Zacatlán",
      seatsCount: 2,
      isRead: false,
      createdAt: "2026-11-22T10:00:00.000Z",
      booking: {
        status: "AWAITING_REGISTRATION",
        whatsappPhone: "+522281234567",
        magicToken: "abc123token",
        pendingDeposit: 700,
        currency: "MXN",
      },
    });
  });

  it("booking es null si la reserva ya no existe o está borrada (el JOIN no la trae)", async () => {
    fakeSelects([{ id: NOTIFICATION_ID, type: "PRE_BOOKING", isRead: true, ...missingBookingRow }]);

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.items[0].booking, null);
  });

  it("cada LEFT JOIN filtra por la agencia de la sesión y la reserva excluye las borradas", async () => {
    const recorded = fakeSelects([]);

    await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    const joins = recorded[0]!.joins.map((join) => renderJoin(join.on));
    assert.equal(joins.length, 4);
    const [bookingJoin, tourJoin, travelerJoin, tokenJoin] = joins;
    assert.match(bookingJoin!, /"bookings"\."agency_id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/);
    assert.match(bookingJoin!, /"bookings"\."deleted_at" is null/);
    assert.match(tourJoin!, /"tours"\."agency_id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/);
    assert.match(
      travelerJoin!,
      /"travelers"\."agency_id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/,
    );
    assert.match(
      tokenJoin!,
      /"magic_tokens"\."agency_id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/,
    );
    for (const join of joins) assert.doesNotMatch(join, new RegExp(AGENCY_B));
  });

  describe("toNotificationBooking (anticipo pendiente con la regla del dashboard)", () => {
    it("sin abonos: anticipo por persona × lugares apartados", () => {
      assert.equal(toNotificationBooking(liveBookingRow)?.pendingDeposit, 1000);
    });

    it("con abonos parciales: resta lo pagado", () => {
      const booking = toNotificationBooking({ ...liveBookingRow, bookingAmountPaid: 250.5 });
      assert.equal(booking?.pendingDeposit, 749.5);
    });

    it("nunca es negativo si lo pagado supera el anticipo", () => {
      const booking = toNotificationBooking({ ...liveBookingRow, bookingAmountPaid: 2500 });
      assert.equal(booking?.pendingDeposit, 0);
    });

    it("anticipo $0 → nada pendiente", () => {
      const booking = toNotificationBooking({ ...liveBookingRow, tourDepositPerPerson: 0 });
      assert.equal(booking?.pendingDeposit, 0);
    });

    it("sin Magic Link usa la misma heurística del dashboard (total ÷ precio)", () => {
      const booking = toNotificationBooking({
        ...liveBookingRow,
        magicToken: null,
        magicTokenPassengers: null,
        bookingTotalPrice: 4500,
      });
      assert.equal(booking?.magicToken, null);
      assert.equal(booking?.pendingDeposit, 1500);
    });

    it("titular anonimizado o sin WhatsApp → whatsappPhone null; refleja el estado y la moneda actuales", () => {
      const booking = toNotificationBooking({
        ...liveBookingRow,
        titularWhatsappPhone: null,
        bookingStatus: "CONFIRMED",
        tourCurrency: "USD",
      });
      assert.equal(booking?.whatsappPhone, null);
      assert.equal(booking?.status, "CONFIRMED");
      assert.equal(booking?.currency, "USD");
    });

    it("reserva no traída por el JOIN → null", () => {
      assert.equal(toNotificationBooking(missingBookingRow), null);
    });
  });

  it("PATCH /:id/read filtra por id y agencia (compartido por la agencia)", async () => {
    const calls = fakeUpdate([{ id: NOTIFICATION_ID, isRead: true }]);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${NOTIFICATION_ID}/read`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0]!.values, { isRead: true });
    assert.ok(rowMatches(calls[0]!.where, { id: NOTIFICATION_ID, agencyId: AGENCY_A }));
    assert.ok(!rowMatches(calls[0]!.where, { id: NOTIFICATION_ID, agencyId: AGENCY_B }));
  });

  it("PATCH /:id/read de otra agencia o inexistente → 404", async () => {
    fakeUpdate([]);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${NOTIFICATION_ID}/read`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 404);
  });

  it("PATCH /:id/read con un id inválido → 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/no-es-uuid/read",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });
    assert.equal(res.statusCode, 400);
  });

  it("PATCH /read-all marca las no leídas de la agencia de la sesión", async () => {
    const calls = fakeUpdate([{ id: "n1" }, { id: "n2" }]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/read-all",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.updatedCount, 2);
    assert.ok(rowMatches(calls[0]!.where, { agencyId: AGENCY_A, isRead: false }));
    assert.ok(!rowMatches(calls[0]!.where, { agencyId: AGENCY_B, isRead: false }));
  });

  it("en Modo Solo Lectura se pueden marcar como leídas (no es una operación de negocio)", async () => {
    const readOnlyApp = await createTestApp({ isAgencyReadOnly: async () => true });
    try {
      fakeUpdate([{ id: NOTIFICATION_ID, isRead: true }]);
      const one = await readOnlyApp.inject({
        method: "PATCH",
        url: `/api/notifications/${NOTIFICATION_ID}/read`,
        cookies: sessionCookie(readOnlyApp, AGENCY_A, USER_A),
      });
      const all = await readOnlyApp.inject({
        method: "PATCH",
        url: "/api/notifications/read-all",
        cookies: sessionCookie(readOnlyApp, AGENCY_A, USER_A),
      });
      assert.equal(one.statusCode, 200);
      assert.equal(all.statusCode, 200);
    } finally {
      await readOnlyApp.close();
    }
  });
});
