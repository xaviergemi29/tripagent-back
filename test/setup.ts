// Se carga con `--import` ANTES que cualquier módulo de la app (ver script "test" en package.json).
// Forzamos una DATABASE_URL inalcanzable: dotenv no sobrescribe variables ya definidas, así que
// ninguna prueba puede tocar la base real (Neon). Toda consulta debe estar simulada (mock);
// una consulta no simulada falla con ECONNREFUSED en lugar de escribir datos.
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/tripagent_test";
process.env.JWT_SECRET = "test-jwt-secret-solo-para-pruebas-0123456789";
process.env.COOKIE_SECRET = "test-cookie-secret-solo-para-pruebas-0123456789";
process.env.NODE_ENV = "test";
