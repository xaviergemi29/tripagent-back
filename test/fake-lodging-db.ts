import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { getTableColumns, getTableName, is, sql, SQL, Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";

/**
 * Base EN MEMORIA para el hospedaje (regla 27). A diferencia de `rowMatches`, entiende los JOIN y
 * los operadores que usa `LodgingService`, evaluando el SQL real que arma Drizzle:
 * - condiciones `=`, `<>` (con la semántica de NULL de Postgres), `is null` e `in (...)` unidas con
 *   `and`, entre columnas calificadas (`"tabla"."columna"` o alias) y parámetros;
 * - `innerJoin` (producto filtrado por el ON), `orderBy` con `asc`/`desc` y `for("update")`;
 * - `insert … returning`, `update … set … where` y `delete … where [returning]`;
 * - los índices únicos del hospedaje (fila por fila, como Postgres con un índice no diferible:
 *   lanzan `code: "23505"`) y el `ON DELETE CASCADE` de habitación → camas asignadas.
 * Cualquier otra forma de SQL lanza un error para no dar falsos positivos. `db.transaction` revierte
 * todo si la función lanza y registra en `writes` cada escritura intentada.
 */

type Row = Record<string, unknown>;
type Joined = Record<string, Row>;

export type LodgingTables = Record<
  | "tours"
  | "tour_hotels"
  | "tour_hotel_rooms"
  | "tour_hotel_room_assignments"
  | "bookings"
  | "booking_passengers"
  | "travelers",
  Row[]
>;

export interface LodgingWrite {
  table: string;
  op: "insert" | "update" | "delete";
  values?: unknown;
}

const dialect = new PgDialect();
const ORIGINAL_NAME = Symbol.for("drizzle:OriginalName");

const render = (chunk: unknown) => dialect.sqlToQuery(sql`${chunk}`);

/** Por tabla real: nombre de columna en BD → propiedad de Drizzle (`booking_status` → `status`). */
const FIELD_BY_COLUMN = new Map<string, Map<string, string>>();
for (const value of Object.values(schema)) {
  if (!is(value, Table)) continue;
  const columns = new Map<string, string>();
  for (const [key, column] of Object.entries(getTableColumns(value))) columns.set(column.name, key);
  FIELD_BY_COLUMN.set(getTableName(value), columns);
}

/** Alias usado en el SQL → tabla real. */
type Aliases = Record<string, string>;

function fieldOf(aliases: Aliases, alias: string, column: string): string {
  const field = FIELD_BY_COLUMN.get(aliases[alias] ?? alias)?.get(column);
  if (!field) throw new Error(`fake-lodging-db: columna desconocida ("${alias}"."${column}")`);
  return field;
}

/** Nombre real de la tabla (aunque sea un alias) y cómo se nombra en el SQL. */
function tableRef(table: unknown): { name: string; alias: string } {
  if (!is(table, Table)) throw new Error("fake-lodging-db: se esperaba una tabla de Drizzle");
  const alias = getTableName(table);
  const original = (table as unknown as Record<symbol, unknown>)[ORIGINAL_NAME];
  return { name: typeof original === "string" ? original : alias, alias };
}

const COLUMN = /^"(\w+)"\."(\w+)"$/;

function columnRef(chunk: unknown, aliases: Aliases): { alias: string; field: string } {
  const match = COLUMN.exec(render(chunk).sql);
  if (!match) throw new Error(`fake-lodging-db: columna no soportada (${render(chunk).sql})`);
  return { alias: match[1]!, field: fieldOf(aliases, match[1]!, match[2]!) };
}

/** Evalúa un WHERE/ON de Drizzle contra una fila compuesta `{ alias: fila }`. */
export function evaluate(where: SQL | undefined, row: Joined, aliases: Aliases): boolean {
  if (!where) return true;
  const { sql: text, params } = dialect.sqlToQuery(where);
  const lists: string[] = [];
  const flat = text
    .replace(/ in \(([^)]*)\)/g, (_, list: string) => ` in #${lists.push(list) - 1}`)
    .replace(/[()]/g, "")
    .trim();

  const operand = (token: string): unknown => {
    const param = /^\$(\d+)$/.exec(token);
    if (param) return params[Number(param[1]) - 1];
    const column = /^"(\w+)"\."(\w+)"$/.exec(token);
    if (!column) throw new Error(`fake-lodging-db: operando no soportado (${token})`);
    const source = row[column[1]!];
    if (!source) throw new Error(`fake-lodging-db: tabla sin unir (${column[1]})`);
    return source[fieldOf(aliases, column[1]!, column[2]!)];
  };

  return flat.split(" and ").every((condition) => {
    const nullCheck = /^(\S+) is (not )?null$/.exec(condition);
    if (nullCheck) return (operand(nullCheck[1]!) == null) !== Boolean(nullCheck[2]);
    const inList = /^(\S+) in #(\d+)$/.exec(condition);
    if (inList) {
      const value = operand(inList[1]!);
      return lists[Number(inList[2])]!.split(", ").some((token) => operand(token) === value);
    }
    const comparison = /^(\S+) (=|<>) (\S+)$/.exec(condition);
    if (!comparison) throw new Error(`fake-lodging-db: condición no soportada (${condition})`);
    const left = operand(comparison[1]!);
    const right = operand(comparison[3]!);
    if (left == null || right == null) return false; // NULL nunca es igual ni distinto
    return comparison[2] === "=" ? left === right : left !== right;
  });
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : 1;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Índices únicos simulados: tabla → columnas (+ condición parcial). */
const UNIQUE_INDEXES: Record<string, { name: string; fields: string[]; partial?: string }[]> = {
  tour_hotel_room_assignments: [
    { name: "idx_room_assignments_room_slot", fields: ["roomId", "slotIndex"] },
    { name: "idx_room_assignments_hotel_passenger", fields: ["hotelId", "bookingPassengerId"] },
  ],
  tour_hotel_rooms: [
    {
      name: "idx_tour_hotel_rooms_hotel_number",
      fields: ["hotelId", "roomNumber"],
      partial: "roomNumber",
    },
  ],
};

/** `ON DELETE CASCADE` simulados: tabla borrada → [tabla hija, columna FK]. */
const CASCADES: Record<string, [string, string][]> = {
  tour_hotel_rooms: [["tour_hotel_room_assignments", "roomId"]],
};

/** Lanza un 23505 si `row` choca con otra fila de `rows` en algún índice único de la tabla. */
function assertUnique(name: string, rows: readonly Row[], row: Row): void {
  for (const index of UNIQUE_INDEXES[name] ?? []) {
    if (index.partial && row[index.partial] == null) continue;
    const clash = rows.some(
      (other) => other !== row && index.fields.every((field) => other[field] === row[field]),
    );
    if (clash) {
      throw Object.assign(
        new Error(`duplicate key value violates unique constraint "${index.name}"`),
        {
          code: "23505",
        },
      );
    }
  }
}

export function createFakeLodgingDb(initial: Partial<LodgingTables> = {}) {
  let tables: LodgingTables = clone({
    tours: [],
    tour_hotels: [],
    tour_hotel_rooms: [],
    tour_hotel_room_assignments: [],
    bookings: [],
    booking_passengers: [],
    travelers: [],
    ...initial,
  });
  const writes: LodgingWrite[] = [];

  const rowsOf = (name: string): Row[] => {
    const rows = tables[name as keyof LodgingTables];
    if (!rows) throw new Error(`fake-lodging-db: tabla no simulada (${name})`);
    return rows;
  };

  const project = (
    fields: Record<string, unknown> | undefined,
    row: Joined,
    base: string,
    aliases: Aliases,
  ) => {
    if (!fields) return clone(row[base]!);
    return Object.fromEntries(
      Object.entries(fields).map(([key, column]) => {
        const { alias, field } = columnRef(column, aliases);
        return [key, clone(row[alias]?.[field] ?? null)];
      }),
    );
  };

  const select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const base = tableRef(table);
      const joins: { name: string; alias: string; on: SQL }[] = [];
      let where: SQL | undefined;
      let order: unknown[] = [];
      const run = () => {
        const aliases: Aliases = { [base.alias]: base.name };
        for (const join of joins) aliases[join.alias] = join.name;
        let rows: Joined[] = rowsOf(base.name).map((row) => ({ [base.alias]: row }));
        for (const join of joins) {
          rows = rows.flatMap((row) =>
            rowsOf(join.name)
              .map((other) => ({ ...row, [join.alias]: other }))
              .filter((candidate) => evaluate(join.on, candidate, aliases)),
          );
        }
        rows = rows.filter((row) => evaluate(where, row, aliases));
        const keys = order.map((item) => {
          const match = /^"(\w+)"\."(\w+)"(?: (asc|desc))?$/.exec(render(item).sql);
          if (!match) throw new Error(`fake-lodging-db: orderBy no soportado`);
          return {
            alias: match[1]!,
            field: fieldOf(aliases, match[1]!, match[2]!),
            desc: match[3] === "desc",
          };
        });
        rows.sort((a, b) => {
          for (const key of keys) {
            const diff = compareValues(a[key.alias]?.[key.field], b[key.alias]?.[key.field]);
            if (diff !== 0) return key.desc ? -diff : diff;
          }
          return 0;
        });
        return rows.map((row) => project(fields, row, base.alias, aliases));
      };
      const builder = {
        innerJoin: (joinTable: unknown, on: SQL) => {
          joins.push({ ...tableRef(joinTable), on });
          return builder;
        },
        where: (w: SQL | undefined) => {
          where = w;
          return builder;
        },
        orderBy: (...items: unknown[]) => {
          order = items;
          return builder;
        },
        for: () => builder,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(run).then(resolve, reject),
      };
      return builder;
    },
  });

  const tx = {
    select,
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const { name } = tableRef(table);
        const list = (Array.isArray(values) ? values : [values]).map((value) => ({
          id: randomUUID(),
          createdAt: "2026-11-22T12:00:00.000Z",
          ...value,
        }));
        const commit = () => {
          writes.push({ table: name, op: "insert", values: clone(values) });
          const rows = rowsOf(name);
          for (const row of clone(list)) {
            rows.push(row);
            assertUnique(name, rows, row);
          }
        };
        return {
          returning: async (fields?: Record<string, unknown>) => {
            commit();
            return list.map((row) => project(fields, { [name]: row }, name, {}));
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(commit).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async (where: SQL | undefined) => {
          const { name } = tableRef(table);
          writes.push({ table: name, op: "update", values: clone(values) });
          const rows = rowsOf(name);
          for (const row of rows) {
            if (!evaluate(where, { [name]: row }, {})) continue;
            Object.assign(row, values);
            assertUnique(name, rows, row);
          }
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (where: SQL | undefined) => {
        const { name } = tableRef(table);
        const run = () => {
          writes.push({ table: name, op: "delete" });
          const rows = rowsOf(name);
          const removed = rows.filter((row) => evaluate(where, { [name]: row }, {}));
          tables[name as keyof LodgingTables] = rows.filter((row) => !removed.includes(row));
          for (const [child, foreignKey] of CASCADES[name] ?? []) {
            const ids = new Set(removed.map((row) => row.id));
            tables[child as keyof LodgingTables] = rowsOf(child).filter(
              (row) => !ids.has(row[foreignKey]),
            );
          }
          return removed;
        };
        return {
          returning: async (fields?: Record<string, unknown>) =>
            run().map((row) => project(fields, { [name]: row }, name, {})),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => {
                run();
              })
              .then(resolve, reject),
        };
      },
    }),
  };

  mock.method(db, "select", select as never);
  const transaction = mock.method(db, "transaction", (async (fn: (t: unknown) => unknown) => {
    const snapshot = clone(tables);
    try {
      return await fn(tx);
    } catch (error) {
      tables = snapshot; // ROLLBACK
      throw error;
    }
  }) as never);

  return {
    get tables(): LodgingTables {
      return tables;
    },
    writes,
    transaction,
  };
}
