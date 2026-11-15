/**
 * Configuración de seguridad que se resuelve UNA vez al construir la app (buildApp).
 *
 * Antes, JWT_SECRET y COOKIE_SECRET tenían valores por defecto escritos en el código: cualquiera
 * que los conociera podía firmar un JWT con el `agencyId` de otra agencia. Ahora son obligatorios
 * y la API no arranca sin ellos (falla cerrado).
 */

/** Longitud mínima de los secretos (256 bits en hex = 64; 32 es el piso aceptable). */
export const MIN_SECRET_LENGTH = 32;

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityConfigError";
  }
}

type Env = Record<string, string | undefined>;

const requireSecret = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new SecurityConfigError(
      `${name} no está definido. Genera uno con: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new SecurityConfigError(`${name} debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`);
  }
  return value;
};

/** Secretos de firma de sesión (JWT) y de cookies. Lanza si faltan o son débiles. */
export const resolveSecrets = (env: Env = process.env) => {
  const jwtSecret = requireSecret(env, "JWT_SECRET");
  const cookieSecret = requireSecret(env, "COOKIE_SECRET");
  if (jwtSecret === cookieSecret) {
    throw new SecurityConfigError("JWT_SECRET y COOKIE_SECRET deben ser distintos.");
  }
  return { jwtSecret, cookieSecret };
};

/**
 * Orígenes de desarrollo permitidos cuando no hay CORS_ORIGINS: localhost y redes privadas
 * (el front se abre desde el celular por IP local, p. ej. http://192.168.1.77:3000).
 */
const DEV_ORIGIN_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;

/**
 * Orígenes que pueden llamar a la API con credenciales (cookie de sesión).
 * - `CORS_ORIGINS` (lista separada por comas) tiene prioridad: es lo que se usa en producción.
 * - Sin `CORS_ORIGINS`, fuera de producción se permiten localhost y redes privadas.
 * - En producción sin `CORS_ORIGINS` la API no arranca (antes reflejaba CUALQUIER origen).
 */
export const resolveCorsOrigin = (env: Env = process.env): (string | RegExp)[] => {
  const configured = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  if (configured.length > 0) return configured;

  if (env.NODE_ENV === "production") {
    throw new SecurityConfigError(
      "CORS_ORIGINS no está definido. En producción indica el origen del front (p. ej. https://app.tripagent.mx).",
    );
  }
  return [DEV_ORIGIN_PATTERN];
};

/**
 * `trustProxy` de Fastify. Solo detrás de un proxy/balanceador conocido, para que `request.ip`
 * (y por tanto el límite de intentos) use la IP real del cliente. `TRUST_PROXY` acepta un número
 * de saltos ("1") o una lista de IPs/CIDR. Sin la variable: false (no se confía en X-Forwarded-For).
 */
export const resolveTrustProxy = (
  env: Env = process.env,
): boolean | string | ((address: string, hop: number) => boolean) => {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw || raw === "false") return false;
  if (/^\d+$/.test(raw)) {
    // Número de saltos: se confía solo en los N proxies más cercanos.
    const hops = Number(raw);
    return (_address: string, hop: number) => hop < hops;
  }
  return raw;
};
