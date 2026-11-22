import { z } from "zod";

/**
 * El formato del token se valida en el servicio (`staffShareTokenSchema`) para que un token mal
 * formado responda el mismo 404 que uno inexistente, sin consultar la base. El largo ya lo acota
 * Fastify (`maxParamLength`, 100 por defecto: un parámetro más largo no encuentra la ruta → 404).
 */
export const getStaffShareParamsSchema = z.object({
  token: z.string(),
});
