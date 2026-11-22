import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { getTodayInMexico } from "../src/shared/utils/mexico-date.util.js";
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

const TRAVELER_ID = "44444444-4444-4444-8444-444444444444";

const shiftDays = (days: number): string => {
  const date = new Date(`${getTodayInMexico()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Transacción falsa: viajero encontrado o no, viajes activos y el UPDATE de anonimización. */
function fakeTransaction(opts: {
  traveler?: { id: string } | null;
  trips?: { departureDateTime: string; returnDate: string | null; cancelledAt: string | null }[];
}) {
  const updates: { set: Record<string, unknown>; where: SQL }[] = [];
  let findWhere: SQL | undefined;
  const tx = {
    query: {
      travelers: {
        findFirst: async (args: { where: SQL }) => {
          findWhere = args.where;
          return opts.traveler === undefined ? { id: TRAVELER_ID } : opts.traveler;
        },
      },
    },
    select: () => chain(opts.trips ?? []),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: SQL) => {
          updates.push({ set, where });
          return { returning: async () => [{ id: TRAVELER_ID, deletedAt: set.deletedAt }] };
        },
      }),
    }),
  };
  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return { updates, getFindWhere: () => findWhere };
}

describe("DELETE /api/travelers/:id (borrado + anonimización, derecho ARCO)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const remove = () =>
    app.inject({
      method: "DELETE",
      url: `/api/travelers/${TRAVELER_ID}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

  it("borra los datos personales y conserva la fila (reservas y pagos siguen cuadrando)", async () => {
    // Un viaje que ya terminó no impide eliminarlo.
    const { updates, getFindWhere } = fakeTransaction({
      trips: [{ departureDateTime: shiftDays(-30), returnDate: shiftDays(-29), cancelledAt: null }],
    });

    const res = await remove();

    assert.equal(res.statusCode, 200);
    const { set, where } = updates[0]!;
    assert.equal(set.fullName, "Pasajero Eliminado");
    assert.equal(set.whatsappPhone, null);
    assert.equal(set.whatsappCountry, null);
    assert.equal(set.email, null);
    assert.equal(set.emergencyContactName, "");
    assert.equal(set.emergencyContactPhone, "");
    assert.equal(set.emergencyContactCountry, null);
    assert.equal(set.birthDate, null);
    assert.deepEqual(set.customFields, {});
    assert.ok(set.deletedAt);
    assert.ok(rowMatches(where, { id: TRAVELER_ID, agencyId: AGENCY_A }));
    assert.ok(
      !rowMatches(getFindWhere(), { id: TRAVELER_ID, agencyId: AGENCY_B, deletedAt: null }),
    );
    // La respuesta no devuelve datos personales.
    assert.deepEqual(Object.keys(res.json().data).sort(), ["deletedAt", "id"]);
  });

  it("con un viaje próximo o en curso → 409 sin escribir", async () => {
    for (const trip of [
      { departureDateTime: shiftDays(10), returnDate: shiftDays(11), cancelledAt: null },
      { departureDateTime: shiftDays(-1), returnDate: shiftDays(2), cancelledAt: null },
    ]) {
      const { updates } = fakeTransaction({ trips: [trip] });
      const res = await remove();
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /viaje próximo o en curso/);
      assert.equal(updates.length, 0);
      mock.restoreAll();
    }
  });

  it("un viaje próximo en un tour cancelado por la agencia no lo impide", async () => {
    const { updates } = fakeTransaction({
      trips: [
        { departureDateTime: shiftDays(10), returnDate: null, cancelledAt: "2026-11-01T00:00:00Z" },
      ],
    });
    assert.equal((await remove()).statusCode, 200);
    assert.equal(updates.length, 1);
  });

  it("inexistente o de otra agencia → 404", async () => {
    const { updates } = fakeTransaction({ traveler: null });
    assert.equal((await remove()).statusCode, 404);
    assert.equal(updates.length, 0);
  });
});
