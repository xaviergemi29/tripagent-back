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
import { bookingRoutes } from "./modules/bookings/booking.routes.js";
import { agencyRoute } from "./modules/agencies/agency.routes.js";
import { dashboardRoutes } from "./modules/dashboards/dashboard.routes.js";
import { magicTokensRoutes } from "./modules/magic-tokens/magic-token.routes.js";
import { bookingPassengersRoutes } from "./modules/booking-passengers/booking-passengers.routes.js";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { paymentRoutes } from "./modules/payments/payments.routes.js";

const buildApp = async () => {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  // 1. Registrar el plugin de cookies
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || "tu-secreto-super-seguro", // Opcional, para cookies firmadas (signed cookies)
  });

  // 2. Registrar el plugin de JWT
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || "otro-secreto-jwt",
    cookie: {
      cookieName: "token", // Le dice a @fastify/jwt que busque el token aquí
      signed: false, // Cámbialo a true si decides firmar las cookies en el futuro
    },
  });

  app.decorate("authenticate", async function (request, reply) {
    try {
      // jwtVerify buscará automáticamente la cookie 'token' gracias a la config de arriba
      await request.jwtVerify();
    } catch (err) {
      reply.status(401).send({ error: "No autorizado o sesión expirada" });
    }
  });

  // 1. Compiladores de validación (Zod)
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 2. CONFIGURACIÓN GLOBAL DE CORS (Debe ir ANTES de las rutas)
  // Esto habilita la comunicación segura con el Front-End y permite el envío de cookies
  await app.register(cors, {
    // Agrega los puertos estándar de los ecosistemas que manejas (Next.js = 3000, Vite = 5173, Angular = 4200)
    origin: ["http://localhost:3000", "http://localhost:5173", "http://localhost:4200"],
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
  await app.register(agencyRoute, { prefix: "/api/agencies" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboards" });
  await app.register(magicTokensRoutes, { prefix: "/api/magic-tokens" });
  await app.register(bookingPassengersRoutes, { prefix: "/api/bookingPassengers" });
  await app.register(paymentRoutes, { prefix: "/api/payments" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
};

const start = async () => {
  try {
    const app = await buildApp();
    await app.listen({ port: 3001, host: "0.0.0.0" });
    console.log("🚀 Servidor en http://localhost:3001");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
