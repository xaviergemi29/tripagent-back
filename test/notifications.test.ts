import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
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

const NOTIFICATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
    let findArgs: { where?: SQL; limit?: number } = {};
    mock.method(db.query.notifications, "findMany", (async (args: typeof findArgs) => {
      findArgs = args;
      return [{ id: NOTIFICATION_ID, type: "PRE_BOOKING", isRead: false }];
    }) as never);
    mock.method(db, "select", (() => chain([{ value: 3 }])) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.unreadCount, 3);
    assert.equal(res.json().data.items.length, 1);
    assert.equal(findArgs.limit, 20);
    assert.ok(rowMatches(findArgs.where, { agencyId: AGENCY_A }));
    assert.ok(!rowMatches(findArgs.where, { agencyId: AGENCY_B }));
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
