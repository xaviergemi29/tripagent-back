// src/db/index.ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("❌ DATABASE_URL no está definida en las variables de entorno.");
}

/**
 * Conexiones del pool por instancia de la API (`DB_POOL_MAX`, por defecto 10). Con varias
 * instancias, la suma no debe superar el límite de Neon: usa el endpoint con pooler
 * (`-pooler` en el host, PgBouncer) y baja este valor por instancia.
 */
const parsePoolMax = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 10;
};

// Instancia de postgres.js con soporte SSL explícito para Neon
const queryClient = postgres(connectionString, {
  ssl: "require", // Forzamos el TLS para instancias remotas en AWS
  max: parsePoolMax(process.env.DB_POOL_MAX),
});

/** Cierra el pool (apagado ordenado del servidor). */
export const closeDb = () => queryClient.end({ timeout: 5 });

export const db = drizzle(queryClient, { schema });

/** Transacción de Drizzle (el `tx` que recibe el callback de `db.transaction`). */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Cualquier ejecutor de consultas: la conexión global o una transacción en curso. */
export type DbExecutor = typeof db | DbTransaction;
