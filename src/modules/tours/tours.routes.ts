import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createTourBodySchema,
  getTourByIdParamsSchema,
  getToursQuerySchema,
  updateTourBodySchema,
} from "./tours.schema.js";
import { TourService } from "./tours.service.js";
import { AGENCY_ID } from "../../constants.js";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads", "brochures");

// Inicialización asíncrona/idempotente de directorio
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export async function tourRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // 1. GET
  server.get(
    "/",
    {
      schema: {
        querystring: getToursQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const tours = await TourService.findTours(request.query, AGENCY_ID);
        return reply.status(200).send(tours);
      } catch (error) {
        app.log.error(error, "Error al consultar tours");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 1. POST / (Crear)
  server.post(
    "/",
    {
      schema: {
        body: createTourBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const tour = await TourService.createTour(request.body, AGENCY_ID);
        return reply.status(201).send({ data: tour });
      } catch (error: any) {
        app.log.error(error, "Error al crear tour");

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 2. GET /:id (Consultar por UUID)
  server.get(
    "/:id",
    {
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const tour = await TourService.findTourById(id, AGENCY_ID);

        if (!tour) {
          return reply.status(404).send({ error: "Tour no encontrado" });
        }

        return reply.status(200).send({ data: tour });
      } catch (error) {
        // ✅ Corregido mensaje de log
        app.log.error(error, "Error al consultar tour por ID");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 3. PATCH /:id (Actualizar parcial)
  server.patch(
    "/:id",
    {
      schema: {
        params: getTourByIdParamsSchema,
        body: updateTourBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const body = request.body;

        const tour = await TourService.updateTour(id, body, AGENCY_ID);

        if (!tour) {
          return reply.status(404).send({ error: "Tour no encontrado" });
        }

        return reply.status(200).send({ data: tour });
      } catch (error: any) {
        app.log.error(error, "Error al actualizar tour");

        if (error?.code === "23505") {
          return reply.status(409).send({ error: "El título ingresado ya pertenece a otro tour" });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.delete(
    "/:id",
    {
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const tour = await TourService.softDeleteTour(id, AGENCY_ID);

        if (!tour) {
          return reply.status(404).send({
            error: "tour no encontrado",
          });
        }

        return reply.status(200).send({
          data: tour,
        });
      } catch (error: any) {
        app.log.error(error, "Error al eliminar tour por ID");

        if (error?.code === "23503") {
          return reply.status(409).send({
            error: "No se puede eliminar el tour porque tiene registros o reservas asociadas",
          });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.post(
    "/:id/brochure",
    {
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;

        // 1. Interceptar el archivo multipart a través del plugin de Fastify
        const data = await request.file();

        if (!data) {
          return reply.status(400).send({ error: "No se adjuntó ningún archivo" });
        }

        if (data.mimetype !== "application/pdf") {
          return reply.status(400).send({ error: "El archivo debe ser un PDF válido" });
        }

        // 2. Definir ruta local y nombre seguro
        const safeFilename = `tour-${id}-${Date.now()}.pdf`;
        const savePath = path.join(UPLOADS_DIR, safeFilename);

        // 3. Transferencia asíncrona mediante Streams (Non-blocking I/O)
        await pipeline(data.file as unknown as Readable, fs.createWriteStream(savePath));

        // 4. Actualizar ruta relativa en PostgreSQL
        const publicUrl = `/uploads/brochures/${safeFilename}`;
        const tour = await TourService.updateBrochureUrl(id, publicUrl, AGENCY_ID);

        return reply.status(200).send({ data: tour });
      } catch (error) {
        app.log.error(error, "Error al procesar la subida del folleto");
        return reply.status(500).send({ error: "Error interno al procesar el archivo" });
      }
    },
  );
}
