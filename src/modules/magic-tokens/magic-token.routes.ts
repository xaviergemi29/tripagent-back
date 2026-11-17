import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MagicTokenService } from "./magic-token.service.js";
import { lookupTravelerQuerySchema, validateTokenParamsSchema } from "./magic-token.schema.js";
import { TravelerService } from "../travelers/travelers.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

/** Magic Link (público: lo autentica el token de la URL). Prefijo: /api/magic-tokens. */
export async function magicTokensRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:token/validate",
    {
      config: { rateLimit: RATE_LIMITS.publicRead },
      schema: { params: validateTokenParamsSchema },
    },
    async (request, reply) => {
      try {
        const result = await MagicTokenService.validate(request.params.token);

        if (result.error) {
          const statusCode =
            result.error.code === "NOT_FOUND" ? 404 : result.error.code === "EXPIRED" ? 410 : 409;
          return reply.status(statusCode).send({ isValid: false, error: result.error });
        }

        return reply.status(200).send(result);
      } catch (error) {
        // Formato propio del Magic Link (`{ isValid, error: { code, message } }`) que el front lee.
        // `SERVER_ERROR`, no `NOT_FOUND`: una falla nuestra no debe decirle al cliente que su enlace
        // no existe (hasta el 2026-11-16 lo hacía); el front le pide reintentar.
        app.log.error(error, "Error interno validando token");
        return reply.status(500).send({
          isValid: false,
          error: { code: "SERVER_ERROR", message: "Error interno del servidor" },
        });
      }
    },
  );

  /**
   * Autocompletar del formulario de registro por WhatsApp (sin notas médicas). Solo responde
   * mientras la reserva del token espera el registro del grupo (ver `findRegistrationContext`).
   */
  server.get(
    "/:token/lookup-traveler",
    {
      config: { rateLimit: RATE_LIMITS.lookupTraveler },
      schema: { params: validateTokenParamsSchema, querystring: lookupTravelerQuerySchema },
    },
    async (request, reply) => {
      const context = await MagicTokenService.findRegistrationContext(request.params.token);
      if (!context) return reply.status(400).send({ error: "Token inválido o expirado" });

      const traveler = await TravelerService.findSingleTravelerByPhone(
        request.query.phone,
        context.agencyId,
      );
      if (!traveler) return reply.status(404).send({ message: "No registrado" });

      return reply.status(200).send({
        fullName: traveler.fullName,
        email: traveler.email,
        emergencyContactName: traveler.emergencyContactName,
        emergencyContactPhone: traveler.emergencyContactPhone,
        birthDate: traveler.birthDate,
      });
    },
  );
}
