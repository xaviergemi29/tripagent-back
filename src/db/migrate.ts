import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL no está definida en las variables de entorno");
}

// Para las migraciones, abrimos una conexión dedicada de un solo cliente (max: 1)
// para evitar bloqueos o conflictos con el pool general de la aplicación.
const migrationClient = postgres(connectionString, { max: 1 });
const db = drizzle(migrationClient);

async function main() {
  console.log("⏳ Ejecutando migraciones en la base de datos...");

  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("✅ ¡Migraciones aplicadas con éxito!");
  await migrationClient.end();
}

main().catch((err) => {
  console.error("❌ Error crítico al aplicar las migraciones:", err);
  process.exit(1);
});
