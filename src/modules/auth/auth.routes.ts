import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  changePasswordBodySchema,
  loginBodySchema,
  registerAgencyBodySchema,
} from "./auth.schema.js";
import { AuthService, INVALID_CREDENTIALS_MESSAGE } from "./auth.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

/** Vida de la sesión: el JWT y la cookie expiran a la vez (antes la cookie duraba 7 días). */
const SESSION_TTL_SECONDS = 60 * 60 * 24;

export async function authRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  /** Firma el JWT y lo guarda en la cookie httpOnly `token` (login y registro de agencia). */
  const startSession = (
    reply: FastifyReply,
    user: { id: string; agencyId: string; role: "ADMIN" | "SALES" | "GUIDE" },
  ) => {
    const token = app.jwt.sign(
      { id: user.id, agencyId: user.agencyId, role: user.role },
      { expiresIn: SESSION_TTL_SECONDS },
    );
    reply.setCookie("token", token, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: SESSION_TTL_SECONDS,
    });
  };

  server.post(
    "/login",
    {
      config: { rateLimit: RATE_LIMITS.login },
      schema: {
        body: loginBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const user = await AuthService.authenticate(request.body);
        startSession(reply, user);

        return reply.status(200).send({
          success: true,
          data: {
            user,
            message: "Autenticación exitosa",
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === INVALID_CREDENTIALS_MESSAGE) {
          return reply.status(401).send({ error: INVALID_CREDENTIALS_MESSAGE });
        }
        // Cualquier otro fallo (p. ej. la base de datos) es un 500 sin detalles internos.
        app.log.error(error, "Error en el proceso de login");
        return reply.status(500).send({ error: "Error al iniciar sesión" });
      }
    },
  );

  // Alta de agencia desde la web (/registro, 2026-11-22): crea agencia + ADMIN en prueba de 30 días
  // y deja la sesión iniciada. Correo ya registrado → 409 (manejador global).
  server.post(
    "/register-agency",
    {
      config: { rateLimit: RATE_LIMITS.registerAgency },
      schema: { body: registerAgencyBodySchema },
    },
    async (request, reply) => {
      const user = await AuthService.registerAgency(request.body);
      startSession(reply, user);
      return reply.status(201).send({
        success: true,
        data: { user, message: "Cuenta de agencia creada" },
      });
    },
  );

  server.get(
    "/me",
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const user = await AuthService.getUserProfile(request.user.id);
      return reply.send({ data: user });
    },
  );

  server.post("/logout", async (_, reply) => {
    reply.clearCookie("token", {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    return reply.status(200).send({
      success: true,
      message: "Sesión cerrada correctamente",
    });
  });

  server.post(
    "/change-password",
    {
      config: { rateLimit: RATE_LIMITS.changePassword },
      preHandler: [app.authenticate],
      schema: {
        body: changePasswordBodySchema,
      },
    },
    async (request, reply) => {
      // Contraseña actual incorrecta → BusinessRuleError (400) en el manejador global.
      await AuthService.changePassword(request.user.id, request.body);
      return reply.status(200).send({
        success: true,
        message: "Contraseña actualizada correctamente",
      });
    },
  );
}
