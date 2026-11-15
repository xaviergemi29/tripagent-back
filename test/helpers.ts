import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildApp } from "../src/app.js";

export const AGENCY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const AGENCY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

/**
 * App de pruebas. Las pruebas no tocan Neon: la verificación de sesión activa (B1) se sustituye por
 * `isSessionActive` (por defecto, todos los usuarios activos).
 */
export async function createTestApp(
  options: { isSessionActive?: (userId: string, agencyId: string) => Promise<boolean> } = {},
): Promise<TestApp> {
  const app = await buildApp({ isSessionActive: options.isSessionActive ?? (async () => true) });
  await app.ready();
  return app;
}

/** Cookie de sesión válida para un operador de la agencia indicada. */
export function sessionCookie(app: TestApp, agencyId: string, userId: string) {
  return { token: app.jwt.sign({ id: userId, agencyId, role: "ADMIN" as const }) };
}

const dialect = new PgDialect();

const toCamel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Simula cómo Postgres evaluaría un `where` de Drizzle formado por condiciones `eq(col, valor)`
 * e `isNull(col)` unidas con `and(...)`, contra una fila con claves camelCase (como Drizzle).
 * Si el WHERE usa cualquier otro operador lanza un error, para no dar falsos positivos.
 */
export function rowMatches(where: SQL | undefined, row: Record<string, unknown>): boolean {
  if (!where) return true;
  const { sql, params } = dialect.sqlToQuery(where);
  const condition = /"\w+"\."(\w+)" (?:= \$(\d+)|is null)/g;

  const leftover = sql
    .replace(condition, "")
    .replace(/[()]|\band\b/g, "")
    .trim();
  if (leftover) throw new Error(`rowMatches no soporta este WHERE: ${sql}`);

  return [...sql.matchAll(condition)].every(([, column, paramIndex]) => {
    const value = row[toCamel(column!)];
    return paramIndex ? value === params[Number(paramIndex) - 1] : value == null;
  });
}

/**
 * Doble de un query builder de Drizzle (select/update/delete/insert): cualquier método encadenado
 * devuelve el mismo objeto y al hacer `await` resuelve `result`.
 */
export function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then"
          ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject)
          : () => proxy,
    },
  );
  return proxy;
}
