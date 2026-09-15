import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { loginBodySchema } from "./auth.schema.js";
import { AuthService } from "./auth.service.js";

export async function authRoutes(app: FastifyInstance) {
    const server = app.withTypeProvider<ZodTypeProvider>();

    server.post(
        "/login",
        {
            schema: {
                body: loginBodySchema
            }
        },
        async (request, reply) => {
            try {
                const user = await AuthService.authenticate(request.body);

                const token = app.jwt.sign({
                    sub: user.id,
                    agencyId: user.agencyId,
                    role: user.role,
                }, {
                    expiresIn: "7d"
                });

                reply.setCookie("token", token, {
                    path: "/",
                    httpOnly: true,
                    secure: process.env.NODE_ENV === "production",
                    sameSite: "strict",
                    maxAge: 60 * 60 * 24 * 7
                });

                return reply.status(200).send({
                    success: true,
                    data: {
                        user,
                        message: "Autenticación exitosa"
                    }
                });
            } catch (error) {
                app.log.error(error, "Error en el proceso de login");
                const errorMessage = error instanceof Error ? error.message : "Error al iniciar sesión";
                return reply.status(401).send({ error: errorMessage });
            }
        }
    );

    server.get(
        "/me", 
        { 
            preHandler: [app.authenticate] 
        },
        async (request, reply) => {
            const user = await AuthService.getUserProfile(request.user.sub);
            return reply.send({ data: user });
        }
    );

    // 🚪 NUEVO: Endpoint de Logout
    server.post(
        "/logout",
        async (_, reply) => {
            reply.clearCookie("token", {
                path: "/",
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "strict",
            });

            return reply.status(200).send({
                success: true,
                message: "Sesión cerrada correctamente"
            });
        }
    );
}