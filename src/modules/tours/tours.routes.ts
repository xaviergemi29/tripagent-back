import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  assignVehicleBodySchema,
  cancelTourBodySchema,
  createTourBodySchema,
  getTourByIdParamsSchema,
  getToursQuerySchema,
  updateTourBodySchema,
} from "./tours.schema.js";
import { brochureFilePrefix, TourService } from "./tours.service.js";
import {
  ensureUploadDirs,
  hasFileSignature,
  removeAbsoluteFile,
  removeUpload,
  toPublicUploadPath,
  writeUpload,
} from "../../shared/storage/uploads.js";
import { BusinessRuleError } from "../../shared/errors/domain-errors.js";
import { StaffShareService } from "../staff-share/staff-share.service.js";
import { getErrorCode } from "../../shared/utils/db-error.util.js";

const BROCHURE_TOO_LARGE = "El folleto no debe pesar más de 5 MB";

/**
 * Tours de la agencia de la sesión. Prefijo: /api/tours. Los errores de dominio (404/400/409) los
 * traduce el manejador global de app.ts; aquí solo se mapean los códigos de Postgres propios.
 */
export async function tourRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  ensureUploadDirs();

  server.get(
    "/",
    { onRequest: [app.authenticate], schema: { querystring: getToursQuerySchema } },
    async (request, reply) => {
      const tours = await TourService.findTours(request.query, request.user.agencyId);
      return reply.status(200).send(tours);
    },
  );

  server.post(
    "/",
    { onRequest: [app.authenticate], schema: { body: createTourBodySchema } },
    async (request, reply) => {
      const tour = await TourService.createTour(
        request.body,
        request.user.agencyId,
        request.user.id,
      );
      return reply.status(201).send({ data: tour });
    },
  );

  server.get(
    "/:tourId",
    { onRequest: [app.authenticate], schema: { params: getTourByIdParamsSchema } },
    async (request, reply) => {
      const tour = await TourService.findTourById(request.params.tourId, request.user.agencyId);
      if (!tour) return reply.status(404).send({ error: "Tour no encontrado" });
      return reply.status(200).send({ data: tour });
    },
  );

  // PATCH parcial: capacidad no menor que los ocupados, moneda/precio congelados (409).
  server.patch(
    "/:tourId",
    {
      onRequest: [app.authenticate],
      schema: { params: getTourByIdParamsSchema, body: updateTourBodySchema },
    },
    async (request, reply) => {
      try {
        const tour = await TourService.updateTour(
          request.params.tourId,
          request.body,
          request.user.agencyId,
          request.user.id,
        );
        if (!tour) return reply.status(404).send({ error: "Tour no encontrado" });
        return reply.status(200).send({ data: tour });
      } catch (error) {
        if (getErrorCode(error) === "23505") {
          return reply.status(409).send({ error: "El título ingresado ya pertenece a otro tour" });
        }
        throw error;
      }
    },
  );

  // Cancelación del tour por la agencia (decisión del PM, 2026-11-14). 409 ya cancelado o finalizado.
  server.post(
    "/:tourId/cancel",
    {
      onRequest: [app.authenticate],
      schema: { params: getTourByIdParamsSchema, body: cancelTourBodySchema },
    },
    async (request, reply) => {
      const result = await TourService.cancelTour(
        request.params.tourId,
        request.body,
        request.user.agencyId,
        request.user.id,
      );
      if (!result) return reply.status(404).send({ error: "Tour no encontrado" });
      return reply.status(200).send({ data: result });
    },
  );

  // Enlace de staff (regla 26, 2026-11-22): crea o regenera el token (el anterior deja de
  // funcionar). 404 tour ajeno; 409 en Modo Auditoría; 402 en Modo Solo Lectura (authenticate).
  server.post(
    "/:tourId/staff-share",
    { onRequest: [app.authenticate], schema: { params: getTourByIdParamsSchema } },
    async (request, reply) => {
      const result = await StaffShareService.createOrRegenerate(
        request.params.tourId,
        request.user.agencyId,
        request.user.id,
      );
      return reply.status(200).send({ data: result });
    },
  );

  // Desactiva el enlace de staff (token = null). 404 tour ajeno.
  server.delete(
    "/:tourId/staff-share",
    { onRequest: [app.authenticate], schema: { params: getTourByIdParamsSchema } },
    async (request, reply) => {
      const result = await StaffShareService.disable(
        request.params.tourId,
        request.user.agencyId,
        request.user.id,
      );
      return reply.status(200).send({ data: result });
    },
  );

  // Borrado lógico protegido: 409 con reservas activas o dinero abonado (regla 15).
  server.delete(
    "/:tourId",
    { onRequest: [app.authenticate], schema: { params: getTourByIdParamsSchema } },
    async (request, reply) => {
      try {
        const tour = await TourService.softDeleteTour(
          request.params.tourId,
          request.user.agencyId,
          request.user.id,
        );
        if (!tour) return reply.status(404).send({ error: "tour no encontrado" });
        return reply.status(200).send({ data: tour });
      } catch (error) {
        if (getErrorCode(error) === "23503") {
          return reply.status(409).send({
            error: "No se puede eliminar el tour porque tiene registros o reservas asociadas",
          });
        }
        throw error;
      }
    },
  );

  /**
   * Folleto PDF (multipart, un archivo, ≤ 5 MB por el límite global de multipart).
   * Orden seguro (auditoría 2026-11-15): 1) el tour debe ser de la agencia ANTES de escribir nada
   * (antes un tour ajeno dejaba un PDF huérfano); 2) el contenido debe empezar con `%PDF-` (el
   * mimetype lo declara el cliente); 3) se actualiza la base y después se borra el folleto anterior;
   * si algo falla, se borra el archivo nuevo.
   */
  server.post(
    "/:tourId/brochure",
    { onRequest: [app.authenticate], schema: { params: getTourByIdParamsSchema } },
    async (request, reply) => {
      const { agencyId, id: userId } = request.user;
      const { tourId } = request.params;
      let savedPath: string | null = null;

      try {
        if (!(await TourService.existsForAgency(tourId, agencyId))) {
          return reply.status(404).send({ error: "Tour no encontrado" });
        }

        const data = await request.file();
        if (!data) return reply.status(400).send({ error: "No se adjuntó ningún archivo" });

        if (data.mimetype !== "application/pdf") {
          data.file.resume();
          return reply.status(400).send({ error: "El archivo debe ser un PDF válido" });
        }

        const fileName = `${brochureFilePrefix(tourId)}${Date.now()}.pdf`;
        savedPath = await writeUpload("brochures", fileName, data.file);

        // Con el archivo ya en disco, el rechazo se lanza (no `reply.send`): así el `finally` lo
        // borra ANTES de que salga la respuesta.
        if (data.file.truncated) throw new BusinessRuleError(BROCHURE_TOO_LARGE);
        if (!(await hasFileSignature(savedPath, "pdf"))) {
          throw new BusinessRuleError("El archivo debe ser un PDF válido");
        }

        const { tour, previousBrochureUrl } = await TourService.updateBrochureUrl(
          tourId,
          toPublicUploadPath("brochures", fileName),
          agencyId,
          userId,
        );
        savedPath = null; // La base ya apunta al archivo nuevo: no se borra.
        await removeUpload("brochures", previousBrochureUrl, brochureFilePrefix(tourId));

        return reply.status(200).send({ data: tour });
      } catch (error) {
        if (getErrorCode(error) === "FST_REQ_FILE_TOO_LARGE") {
          throw new BusinessRuleError(BROCHURE_TOO_LARGE);
        }
        throw error;
      } finally {
        // Archivo rechazado o base sin actualizar: no se deja huérfano en disco.
        await removeAbsoluteFile(savedPath);
      }
    },
  );

  // Asignar unidad de la agencia ({ vehicleId }) o plantilla del catálogo ({ templateId }).
  server.patch(
    "/:tourId/vehicle",
    {
      onRequest: [app.authenticate],
      schema: { params: getTourByIdParamsSchema, body: assignVehicleBodySchema },
    },
    async (request, reply) => {
      try {
        const { vehicleId, templateId } = request.body;
        const tour = await TourService.assignVehicle(
          request.params.tourId,
          { vehicleId, templateId },
          request.user.agencyId,
          request.user.id,
        );
        return reply.status(200).send({ data: tour });
      } catch (error) {
        if (getErrorCode(error) === "23503") {
          return reply.status(400).send({ error: "El vehículo seleccionado no existe." });
        }
        throw error;
      }
    },
  );
}
