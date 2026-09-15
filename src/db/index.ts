// src/db/index.ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("❌ DATABASE_URL no está definida en las variables de entorno.");
}

// Instancia de postgres.js con soporte SSL explícito para Neon
const queryClient = postgres(connectionString, {
  ssl: "require", // Forzamos el TLS para instancias remotas en AWS
  max: 10,        // Pool de conexiones adecuado para desarrollo
});

export const db = drizzle(queryClient, { schema });