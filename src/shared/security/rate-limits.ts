import type { FastifyRequest } from "fastify";
import { getClientIp } from "./client-ip.js";

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
  /** Alta de agencia desde la web: crea cuentas, así que se limita por IP. */
  registerAgency: { max: 5, timeWindow: 60 * MINUTE },
  /** Pre-reserva pública del folleto: ocupa cupo, así que se limita por IP. */
  preBooking: { max: 10, timeWindow: 60 * MINUTE },
  /** Registro del grupo desde el Magic Link. */
  publicRegister: { max: 20, timeWindow: 60 * MINUTE },
  /** Búsqueda de viajero por teléfono (enumeración de clientes de la agencia). */
  lookupTraveler: { max: 20, timeWindow: 10 * MINUTE },
  /**
   * Enlace de staff (croquis y pasajeros de solo lectura): cada carga y recarga de la página es una
   * petición (filtrar o buscar no vuelve a pedir). 120 cada 10 min por IP da margen a 2–3 personas
   * del staff detrás de la misma red (Wi-Fi del autobús, CGNAT del celular). Adivinar un token es
   * inviable (192 bits): el límite frena la automatización, no la fuerza bruta.
   * Por IP del visitante: el front lo pide desde su servidor y reenvía la IP (`getClientIp`).
   */
  staffShare: {
    max: 120,
    timeWindow: 10 * MINUTE,
    keyGenerator: (request: FastifyRequest) => getClientIp(request),
  },
  /** Validación del Magic Link (cada carga de la página) y folleto público; por IP del visitante. */
  publicRead: {
    max: 120,
    timeWindow: MINUTE,
    keyGenerator: (request: FastifyRequest) => getClientIp(request),
  },
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
