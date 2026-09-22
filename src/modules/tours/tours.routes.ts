import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  assignVehicleBodySchema,
  createTourBodySchema,
  getTourByIdParamsSchema,
  getToursQuerySchema,
  updateTourBodySchema,
} from "./tours.schema.js";
import { TourService } from "./tours.service.js";
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
      onRequest: [app.authenticate],
      schema: {
        querystring: getToursQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const tours = await TourService.findTours(request.query, agencyId);
        return reply.status(200).send(tours);
      } catch (error) {
        app.log.error(error, "Error al consultar tours");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 1. POST / (Crear)
  server.post(
    "/",
    {
      onRequest: [app.authenticate],
      schema: {
        body: createTourBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const tour = await TourService.createTour(request.body, agencyId);
        return reply.status(201).send({ data: tour });
      } catch (error) {
        app.log.error(error, "Error al crear tour");

        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 2. GET /:id (Consultar por UUID)
  server.get(
    "/:tourId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { tourId } = request.params;
        const tour = await TourService.findTourById(tourId, agencyId);

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
    "/:tourId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourByIdParamsSchema,
        body: updateTourBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { tourId } = request.params;
        const body = request.body;

        const tour = await TourService.updateTour(tourId, body, agencyId);

        if (!tour) {
          return reply.status(404).send({ error: "Tour no encontrado" });
        }

        return reply.status(200).send({ data: tour });
      } catch (error) {
        app.log.error(error, "Error al actualizar tour");

        if (error?.code === "23505") {
          return reply.status(409).send({ error: "El título ingresado ya pertenece a otro tour" });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.delete(
    "/:tourId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { tourId } = request.params;
        const { agencyId } = request.user;
        const tour = await TourService.softDeleteTour(tourId, agencyId);

        if (!tour) {
          return reply.status(404).send({
            error: "tour no encontrado",
          });
        }

        return reply.status(200).send({
          data: tour,
        });
      } catch (error) {
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
    "/:tourId/brochure",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { tourId } = request.params;

        // 1. Interceptar el archivo multipart a través del plugin de Fastify
        const data = await request.file();

        if (!data) {
          return reply.status(400).send({ error: "No se adjuntó ningún archivo" });
        }

        if (data.mimetype !== "application/pdf") {
          return reply.status(400).send({ error: "El archivo debe ser un PDF válido" });
        }

        // 2. Definir ruta local y nombre seguro
        const safeFilename = `tour-${tourId}-${Date.now()}.pdf`;
        const savePath = path.join(UPLOADS_DIR, safeFilename);

        // 3. Transferencia asíncrona mediante Streams (Non-blocking I/O)
        await pipeline(data.file as unknown as Readable, fs.createWriteStream(savePath));

        // 4. Actualizar ruta relativa en PostgreSQL
        const publicUrl = `/uploads/brochures/${safeFilename}`;
        const tour = await TourService.updateBrochureUrl(tourId, publicUrl, agencyId);

        return reply.status(200).send({ data: tour });
      } catch (error) {
        app.log.error(error, "Error al procesar la subida del folleto");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno al procesar el archivo" });
      }
    },
  );

  server.patch(
    "/:tourId/vehicle",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourByIdParamsSchema,
        body: assignVehicleBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { tourId } = request.params;
        const { vehicleId } = request.body;

        const tour = await TourService.assignVehicle(tourId, vehicleId, agencyId);

        return reply.status(200).send({ data: tour });
      } catch (error) {
        app.log.error(error, "Error al asignar vehículo al tour");

        if (error.message.includes("no encontrado")) {
          return reply.status(404).send({ error: error.message });
        }

        // Manejo de error de constraint de base de datos (Ej. vehicleId no existe en la tabla vehicles)
        if (error?.code === "23503") {
          return reply.status(400).send({ error: "El vehículo seleccionado no existe." });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
