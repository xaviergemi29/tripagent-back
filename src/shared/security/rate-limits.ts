import type { FastifyRequest } from "fastify";

/**
 * Límites de intentos por endpoint (@fastify/rate-limit, registrado con `global: false`: solo
 * aplica a las rutas que declaran `config.rateLimit`). El almacén es en memoria: con varias
 * instancias de la API hay que configurar un store compartido (Redis).
 *
 * Los límites están pensados para no estorbar el uso normal (una oficina detrás de una misma IP,
 * un cliente que recarga su Magic Link) y frenar la fuerza bruta y la automatización.
 */
const MINUTE = 60 * 1000;

/** Normaliza el correo para que mayúsculas o espacios no evadan el límite por cuenta. */
const loginKey = (request: FastifyRequest): string => {
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  return `${request.ip}|${email}`;
};

export const RATE_LIMITS = {
  /** Fuerza bruta de contraseñas: por IP + correo. */
  // preHandler: la clave necesita el body (correo), que en onRequest aún no se ha leído.
  login: { max: 10, timeWindow: 15 * MINUTE, keyGenerator: loginKey, hook: "preHandler" },
  /** Cambio de contraseña: por usuario autenticado (adivinar la actual). */
  changePassword: {
    max: 5,
    timeWindow: 15 * MINUTE,
    keyGenerator: (request: FastifyRequest) => `user:${request.user?.id ?? request.ip}`,
    hook: "preHandler",
  },
  /** Pre-reserva pública del folleto: ocupa cupo, así que se limita por IP. */
  preBooking: { max: 10, timeWindow: 60 * MINUTE },
  /** Registro del grupo desde el Magic Link. */
  publicRegister: { max: 20, timeWindow: 60 * MINUTE },
  /** Búsqueda de viajero por teléfono (enumeración de clientes de la agencia). */
  lookupTraveler: { max: 20, timeWindow: 10 * MINUTE },
  /** Validación del Magic Link (cada carga de la página) y folleto público. */
  publicRead: { max: 120, timeWindow: MINUTE },
} as const;

/** Respuesta 429 con la forma `{ error }` que el front ya sabe mostrar (texto en español). */
export const rateLimitErrorResponse = (
  _request: FastifyRequest,
  context: { statusCode: number; ttl: number },
) => {
  const minutes = Math.max(1, Math.ceil(context.ttl / MINUTE));
  return {
    statusCode: context.statusCode,
    error: `Demasiados intentos. Vuelve a intentarlo en ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`,
  };
};
