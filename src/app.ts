import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { travelerRoutes } from "./modules/travelers/travelers.routes.js";
import { tourRoutes } from "./modules/tours/tours.routes.js";
import { bookingPublicRoutes } from "./modules/bookings/booking-public.routes.js";
import { bookingRoutes } from "./modules/bookings/booking.routes.js";
import { agencyRoute } from "./modules/agencies/agency.routes.js";
import { dashboardRoutes } from "./modules/dashboards/dashboard.routes.js";
import { magicTokensRoutes } from "./modules/magic-tokens/magic-token.routes.js";
import { bookingPassengersRoutes } from "./modules/booking-passengers/booking-passengers.routes.js";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { paymentRoutes } from "./modules/payments/payments.routes.js";
import multipart from "@fastify/multipart";
import { tourBrochureRoutes } from "./modules/tours-public/tours-public.routes.js";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { vehicleRoutes } from "./modules/vehicles/vehicles.routes.js";
import { vehicleTemplateRoutes } from "./modules/vehicle-templates/vehicle-templates.routes.js";
import { tourSeatsRoutes } from "./modules/tour-seats/tour-seats.routes.js";
import { tourManifestRoutes } from "./modules/tour-manifest/tour-manifest.routes.js";
import { notificationRoutes } from "./modules/notifications/notifications.routes.js";
import { staffSharePublicRoutes } from "./modules/staff-share/staff-share.routes.js";
import rateLimit from "@fastify/rate-limit";
import {
  resolveCorsOrigin,
  resolveSecrets,
  resolveTrustProxy,
} from "./shared/security/security.config.js";
import { rateLimitErrorResponse } from "./shared/security/rate-limits.js";
import { AuthService, INACTIVE_USER_MESSAGE } from "./modules/auth/auth.service.js";
import { AgencySubscriptionService } from "./modules/agencies/agency-subscription.service.js";
import {
  SUBSCRIPTION_READ_ONLY_CODE,
  SUBSCRIPTION_READ_ONLY_MESSAGE,
} from "./shared/utils/subscription.util.js";
import {
  BusinessRuleError,
  CapacityExceededError,
  ConflictError,
  NotFoundError,
} from "./shared/errors/domain-errors.js";
import { GENERIC_ERROR_MESSAGE } from "./shared/security/error-message.util.js";

// buildApp() vive separado del arranque (server.ts) para poder probar las rutas con app.inject()
// sin abrir el puerto. Cualquier plugin o módulo nuevo se registra aquí.
export interface BuildAppOptions {
  /**
   * Comprueba que el usuario de la sesión siga activo (B1). Por defecto consulta la BD
   * (`AuthService.isSessionActive`); las pruebas lo sustituyen porque no tocan Neon.
   */
  isSessionActive?: (userId: string, agencyId: string) => Promise<boolean>;
  /**
   * Modo Solo Lectura por suscripción (2026-11-18). Por defecto consulta la agencia
   * (`AgencySubscriptionService.isReadOnly`); las pruebas lo sustituyen.
   */
  isAgencyReadOnly?: (agencyId: string) => Promise<boolean>;
}

/** Métodos que no cambian datos: siempre permitidos en Modo Solo Lectura. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutaciones autenticadas permitidas en Modo Solo Lectura: no son operaciones de negocio. Cerrar
 * sesión no pasa por `authenticate`; cambiar la contraseña es seguridad de la cuenta. Marcar avisos
 * como leídos (2026-11-22) solo ordena la bandeja: el registro del Magic Link sigue generándolos.
 */
const READ_ONLY_ALLOWED_ROUTES = new Set([
  "/api/auth/change-password",
  "/api/notifications/read-all",
  "/api/notifications/:id/read",
]);

export const buildApp = async (options: BuildAppOptions = {}) => {
  const isSessionActive = options.isSessionActive ?? AuthService.isSessionActive;
  const isAgencyReadOnly =
    options.isAgencyReadOnly ??
    ((agencyId: string) => AgencySubscriptionService.isReadOnly(agencyId));
  // Falla cerrado: sin secretos fuertes (o sin CORS_ORIGINS en producción) la API no arranca.
  const { jwtSecret, cookieSecret } = resolveSecrets();
  const corsOrigin = resolveCorsOrigin();

  const app = Fastify({
    logger: true,
    trustProxy: resolveTrustProxy(),
  }).withTypeProvider<ZodTypeProvider>();

  // Encabezados de seguridad en todas las respuestas (API JSON y archivos de /public).
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    if (process.env.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=15552000");
    }
  });

  // Límite de intentos solo en las rutas que declaran `config.rateLimit` (ver shared/security).
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: rateLimitErrorResponse,
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), "public"),
    prefix: "/public/", // La URL será: http://localhost:3001/public/uploads/brochures/archivo.pdf
  });

  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // Límite estricto de 5MB
      files: 1, // Solo 1 archivo por request
    },
  });

  // 1. Registrar el plugin de cookies
  await app.register(fastifyCookie, {
    secret: cookieSecret, // Para cookies firmadas (signed cookies)
  });

  // 2. Registrar el plugin de JWT
  await app.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: {
      cookieName: "token", // Le dice a @fastify/jwt que busque el token aquí
      signed: false, // Cámbialo a true si decides firmar las cookies en el futuro
    },
  });

  app.decorate("authenticate", async function (request, reply) {
    try {
      // jwtVerify buscará automáticamente la cookie 'token' gracias a la config de arriba
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "No autorizado o sesión expirada" });
    }

    // Sesión revocable (decisión del PM, 2026-11-14): un usuario desactivado pierde el acceso en
    // su siguiente petición, aunque su cookie siga vigente. El front, ante un 401, lo manda al login.
    try {
      const { id, agencyId } = request.user;
      if (!(await isSessionActive(id, agencyId))) {
        return reply.status(401).send({ error: INACTIVE_USER_MESSAGE });
      }
    } catch (err) {
      request.log.error(err, "No se pudo verificar la sesión");
      return reply.status(500).send({ error: "Error interno del servidor" });
    }

    // Modo Solo Lectura por suscripción (feedback del PM, 2026-11-18): con la prueba vencida o el
    // pago pendiente, toda mutación de negocio responde 402 sin llegar a la ruta. Las lecturas
    // (tours, Centro de Control, manifiesto, viajeros, Configuración, Suscripción) siguen abiertas.
    if (
      !READ_METHODS.has(request.method) &&
      !READ_ONLY_ALLOWED_ROUTES.has(request.routeOptions.url ?? "")
    ) {
      try {
        if (await isAgencyReadOnly(request.user.agencyId)) {
          return reply
            .status(402)
            .send({ error: SUBSCRIPTION_READ_ONLY_MESSAGE, code: SUBSCRIPTION_READ_ONLY_CODE });
        }
      } catch (err) {
        request.log.error(err, "No se pudo verificar la suscripción");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    }
  });

  // Manejador global de errores (auditoría de arquitectura, 2026-11-14). Las rutas pueden lanzar
  // errores de dominio sin try/catch: NotFound → 404, BusinessRule → 400, Conflict → 409. Los 4xx
  // propios de Fastify (validación, 429, archivo demasiado grande) siguen con el formato por
  // defecto. Cualquier otro error es un 500 con mensaje genérico (falla cerrado, 2026-11-15): los
  // mensajes de negocio viajan solo en errores de dominio; el detalle queda en el log.
  const defaultErrorHandler = app.errorHandler;
  app.setErrorHandler(function (error, request, reply) {
    if (error instanceof NotFoundError) return reply.status(404).send({ error: error.message });
    if (error instanceof ConflictError) {
      return reply.status(409).send({
        error: error.message,
        code: error.code,
        // Lugares que sí quedan, para que el folleto ajuste la solicitud sin leer el mensaje.
        availableSeats:
          error instanceof CapacityExceededError ? Math.max(0, error.availableSeats) : undefined,
      });
    }
    if (error instanceof BusinessRuleError) {
      return reply.status(400).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return defaultErrorHandler.call(this, error, request, reply);
    }
    request.log.error(error, "Error no controlado");
    return reply.status(500).send({ error: GENERIC_ERROR_MESSAGE });
  });

  // 1. Compiladores de validación (Zod)
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 2. CONFIGURACIÓN GLOBAL DE CORS (Debe ir ANTES de las rutas)
  // Esto habilita la comunicación segura con el Front-End y permite el envío de cookies
  await app.register(cors, {
    // Lista explícita de orígenes (CORS_ORIGINS); antes `origin: true` reflejaba cualquier origen.
    origin: corsOrigin,
    credentials: true, // Vital para el manejo de sesiones con httpOnly cookies
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });

  // 3. REGISTRO DE MÓDULOS (Rutas)
  // El código original tenía un app.post("/api/travelers") huérfano.
  // Lo hemos removido para delegar la responsabilidad 100% a sus respectivos módulos.
  await app.register(travelerRoutes, { prefix: "/api/travelers" });
  await app.register(tourRoutes, { prefix: "/api/tours" });
  await app.register(bookingRoutes, { prefix: "/api/bookings" });
  await app.register(bookingPublicRoutes, { prefix: "/api/public" });
  await app.register(agencyRoute, { prefix: "/api/agencies" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboards" });
  await app.register(magicTokensRoutes, { prefix: "/api/magic-tokens" });
  await app.register(bookingPassengersRoutes, { prefix: "/api/bookingPassengers" });
  await app.register(paymentRoutes, { prefix: "/api/payments" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(tourBrochureRoutes, { prefix: "api/tour-brochure" });
  await app.register(vehicleRoutes, { prefix: "/api/vehicles" });
  await app.register(vehicleTemplateRoutes, { prefix: "/api/vehicle-templates" });
  await app.register(tourSeatsRoutes, { prefix: "/api/seats" });
  await app.register(tourManifestRoutes, { prefix: "/api/manifest" });
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  await app.register(staffSharePublicRoutes, { prefix: "/api/public/staff-share" });

  return app;
};
