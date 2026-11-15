import { buildApp } from "./app.js";
import { closeDb } from "./db/index.js";

/** Puerto HTTP (`PORT`, por defecto 3001: el front apunta a http://localhost:3001/api). */
const resolvePort = (raw: string | undefined): number => {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3001;
};

const start = async () => {
  try {
    const app = await buildApp();
    const port = resolvePort(process.env.PORT);

    // Apagado ordenado (despliegues, reinicios del contenedor): deja de aceptar conexiones, termina
    // las peticiones en curso y cierra el pool de Postgres.
    const shutdown = async (signal: string) => {
      app.log.info(`${signal} recibido: cerrando el servidor`);
      try {
        await app.close();
        await closeDb();
      } finally {
        process.exit(0);
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
