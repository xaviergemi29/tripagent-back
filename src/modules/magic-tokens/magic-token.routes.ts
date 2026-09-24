import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MagicTokenService } from "./magic-token.service.js";
import { tokenValidationResponseSchema, validateTokenParamsSchema } from "./magic-token.schema.js";

export async function magicTokensRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:token/validate",
    {
      schema: {
        params: validateTokenParamsSchema,
        response: {
          200: tokenValidationResponseSchema,
          // Devolvemos 400s semánticos según el fallo de negocio
          404: tokenValidationResponseSchema,
          410: tokenValidationResponseSchema, // 410 Gone (para expirados)
          409: tokenValidationResponseSchema, // 409 Conflict (para llenos)
        },
      },
    },
    async (request, reply) => {
      try {
        const { token } = request.params;
        const result = await MagicTokenService.validate(token);

        if (result.error) {
          const statusCode =
            result.error.code === "NOT_FOUND" ? 404 : result.error.code === "EXPIRED" ? 410 : 409;

          return reply.status(statusCode).send({ isValid: false, error: result.error });
        }

        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(error, "Error interno validando token");
        return reply.status(500).send({
          isValid: false,
          error: { code: "NOT_FOUND", message: "Error interno del servidor" },
        });
      }
    },
  );
}
