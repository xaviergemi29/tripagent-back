import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { MIN_SECRET_LENGTH, SecurityConfigError } from "./security.config.js";

/**
 * IP real del visitante en las rutas públicas que el front pide **desde su servidor** (folleto
 * `/p/[id]`, Magic Link `/register` y enlace de staff `/s/[token]` son Server Components): ahí
 * `request.ip` es la IP del servidor de Next y el límite de intentos sería uno solo para todos.
 *
 * El servidor de Next reenvía la IP en `CLIENT_IP_HEADER` y se identifica con
 * `INTERNAL_SECRET_HEADER` = `INTERNAL_PROXY_SECRET`. Sin el secreto correcto la cabecera se ignora
 * (un navegador no puede falsificar su IP con ella). Sin la variable, todo sigue con `request.ip`.
 */
export const CLIENT_IP_HEADER = "x-tripagent-client-ip";
export const INTERNAL_SECRET_HEADER = "x-tripagent-internal-secret";

type Env = Record<string, string | undefined>;

/** `INTERNAL_PROXY_SECRET` opcional; si se define, falla cerrado con menos de 32 caracteres. */
export const resolveInternalProxySecret = (env: Env = process.env): string | null => {
  const secret = env.INTERNAL_PROXY_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SecurityConfigError(
      `INTERNAL_PROXY_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`,
    );
  }
  return secret;
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const headerValue = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim();
};

/** Clave del límite de intentos: la IP reenviada por el servidor de Next o `request.ip`. */
export const getClientIp = (request: FastifyRequest, env: Env = process.env): string => {
  const secret = resolveInternalProxySecret(env);
  if (!secret) return request.ip;
  const sentSecret = headerValue(request, INTERNAL_SECRET_HEADER);
  const forwardedIp = headerValue(request, CLIENT_IP_HEADER);
  if (sentSecret && forwardedIp && isIP(forwardedIp) && safeEqual(sentSecret, secret)) {
    return forwardedIp;
  }
  return request.ip;
};

/**
 * Quita de la URL lo que da acceso o es dato personal antes de escribirla en el log: el token del
 * Magic Link (`/magic-tokens/:token`, `?token=`), el del enlace de staff (`/public/staff-share/:token`)
 * y el teléfono de `lookup-traveler?phone=`.
 */
export const redactSensitiveUrl = (url: string): string =>
  url
    .replace(/(\/magic-tokens\/)[^/?#]+/g, "$1***")
    .replace(/(\/public\/staff-share\/)[^/?#]+/g, "$1***")
    .replace(/([?&](?:token|phone)=)[^&#]*/gi, "$1***");
