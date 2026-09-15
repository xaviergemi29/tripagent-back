import "@fastify/jwt";
import { FastifyRequest, FastifyReply } from "fastify";

// 1. Ampliación para la instancia de Fastify (esto sí va en el módulo "fastify")
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// 2. Ampliación para el payload y el usuario de JWT (DEBE ir en el módulo "@fastify/jwt")
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      agencyId: string;
      role: "ADMIN" | "SALES" | "GUIDE";
    };
    user: {
      sub: string;
      agencyId: string;
      role: "ADMIN" | "SALES" | "GUIDE";
    };
  }
}
