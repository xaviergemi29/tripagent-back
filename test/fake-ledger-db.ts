import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { getTableName, is, SQL, Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../src/db/index.js";
import { rowMatches } from "./helpers.js";

/**
 * Base de datos EN MEMORIA para los flujos de dinero y de grupo (abonos, anulaciones, cancelación de
 * la reserva y baja de acompañantes). A diferencia de los dobles que devuelven valores fijos, aquí
 * cada consulta se evalúa contra las filas:
 * - `where` se evalúa con `rowMatches` (eq / isNull / and, como Postgres); otro operador falla.
 * - `update(...).set(...).where(...)` modifica solo las filas que cumplen el WHERE.
 * - `select({ totalPaid: SUM })`, `select({ count })` y el candado `SELECT … FOR UPDATE` responden
 *   con las filas reales.
 * - `db.transaction` revierte TODO si la función lanza (como un ROLLBACK) y guarda en `writes` cada
 *   escritura intentada, para comprobar que un rechazo no escribió nada antes de validar.
 */

type Row = Record<string, unknown>;

export interface FakeStore {
  tours: Row[];
  bookings: Row[];
  bookingPassengers: Row[];
  magicTokens: Row[];
  payments: Row[];
}

/** Escrituras intentadas (también las de transacciones revertidas). */
export interface WriteLog {
  table: keyof FakeStore;
  op: "insert" | "update";
  values: Row;
}

const TABLES: Record<string, keyof FakeStore> = {
  tours: "tours",
  bookings: "bookings",
  booking_passengers: "bookingPassengers",
  magic_tokens: "magicTokens",
  payments: "payments",
};

const dialect = new PgDialect();
const toCamel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function tableKey(table: unknown): keyof FakeStore {
  if (!is(table, Table)) throw new Error("fake-ledger-db: se esperaba una tabla de Drizzle");
  const key = TABLES[getTableName(table)];
  if (!key) throw new Error(`fake-ledger-db: tabla no simulada (${getTableName(table)})`);
  return key;
}

/** `sql\`${columna} - 1\`` / `+ n`: los únicos SQL que estos flujos usan dentro de `set`. */
function applySqlValue(row: Row, value: SQL): unknown {
  const { sql, params } = dialect.sqlToQuery(value);
  const match = /^"\w+"\."(\w+)" ([+-]) (?:(\d+)|\$(\d+))$/.exec(sql.trim());
  if (!match) throw new Error(`fake-ledger-db: SQL no soportado en set(): ${sql}`);
  const [, column, sign, literal, paramIndex] = match;
  const delta = Number(literal ?? params[Number(paramIndex) - 1]);
  const current = Number(row[toCamel(column!)]);
  return sign === "-" ? current - delta : current + delta;
}

/** Thenable con `.for("update")`, como el query builder de Drizzle. */
function thenable<T>(value: T): PromiseLike<T> & { for: () => PromiseLike<T> } {
  return {
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    for: () => thenable(value),
  };
}

const clone = <T>(value: T): T => structuredClone(value);

export function createFakeLedgerDb(initial: FakeStore) {
  let store: FakeStore = clone(initial);
  const writes: WriteLog[] = [];

  /** Relaciones `with` que leen estos flujos (reserva → tour y token). */
  const withRelations = (key: keyof FakeStore, row: Row, relations?: Record<string, unknown>) => {
    if (!relations) return row;
    const result: Row = { ...row };
    for (const relation of Object.keys(relations)) {
      if (key === "bookings" && relation === "tour") {
        result.tour = clone(store.tours.find((tour) => tour.id === row.tourId) ?? null);
      } else if (key === "bookings" && relation === "magicToken") {
        result.magicToken = clone(
          store.magicTokens.find((token) => token.bookingId === row.id) ?? null,
        );
      } else {
        throw new Error(`fake-ledger-db: relación no simulada (${key}.${relation})`);
      }
    }
    return result;
  };

  const queryApi = (key: keyof FakeStore) => ({
    findFirst: async (options: { where?: SQL; with?: Record<string, unknown> } = {}) => {
      const row = store[key].find((candidate) => rowMatches(options.where, candidate));
      return row ? withRelations(key, clone(row), options.with) : undefined;
    },
    findMany: async (options: { where?: SQL; with?: Record<string, unknown> } = {}) =>
      store[key]
        .filter((candidate) => rowMatches(options.where, candidate))
        .map((row) => withRelations(key, clone(row), options.with)),
  });

  const tx = {
    query: {
      tours: queryApi("tours"),
      bookings: queryApi("bookings"),
      bookingPassengers: queryApi("bookingPassengers"),
      magicTokens: queryApi("magicTokens"),
      payments: queryApi("payments"),
    },
    select: (fields: Record<string, unknown> = {}) => ({
      from: (table: unknown) => ({
        where: (where?: SQL) => {
          const key = tableKey(table);
          const rows = store[key].filter((row) => rowMatches(where, row));
          if ("totalPaid" in fields) {
            const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
            return thenable([{ totalPaid: Math.round(total * 100) / 100 }]);
          }
          if ("count" in fields) return thenable([{ count: rows.length }]);
          return thenable(
            rows.map((row) => Object.fromEntries(Object.keys(fields).map((f) => [f, row[f]]))),
          );
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (where?: SQL) => {
          const key = tableKey(table);
          writes.push({ table: key, op: "update", values: { ...values } });
          for (const row of store[key]) {
            if (!rowMatches(where, row)) continue;
            for (const [field, value] of Object.entries(values)) {
              row[field] = is(value, SQL) ? applySqlValue(row, value) : value;
            }
          }
          return thenable(undefined);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        returning: async () => {
          const key = tableKey(table);
          writes.push({ table: key, op: "insert", values: { ...values } });
          const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...values };
          store[key].push(row);
          return [clone(row)];
        },
      }),
    }),
  };

  mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => {
    const snapshot = clone(store);
    try {
      return await fn(tx);
    } catch (error) {
      store = snapshot; // ROLLBACK
      throw error;
    }
  }) as never);

  return {
    /** Estado actual (después de los commits y rollbacks). */
    get store(): FakeStore {
      return store;
    },
    writes,
    booking: (id: string) => store.bookings.find((row) => row.id === id)!,
    passenger: (bookingId: string, travelerId: string) =>
      store.bookingPassengers.find(
        (row) => row.bookingId === bookingId && row.travelerId === travelerId,
      )!,
    token: (bookingId: string) => store.magicTokens.find((row) => row.bookingId === bookingId)!,
    paymentsOf: (bookingId: string) => store.payments.filter((row) => row.bookingId === bookingId),
  };
}
