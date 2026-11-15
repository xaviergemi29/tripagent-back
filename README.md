# tripagent-api

API de TripAgent: SaaS multi-tenant para agencias de tours en México (reservas grupales, cobranza,
asientos y manifiesto). Fastify 5 + Zod 4 + Drizzle ORM sobre PostgreSQL (Neon).

La documentación técnica completa (modelo de datos, endpoints, reglas de negocio, seguridad y
escalabilidad) está en [CLAUDE.md](CLAUDE.md). Las reglas transversales con el front viven en
`../CLAUDE.md` (carpeta contenedora, fuera de este repo).

## Arranque local

```bash
npm install
cp .env.example .env   # completa DATABASE_URL, JWT_SECRET y COOKIE_SECRET (≥ 32 caracteres, distintos)
npm run dev            # http://localhost:3001/api  (PORT, por defecto 3001)
```

Sin `JWT_SECRET`/`COOKIE_SECRET` válidos la API no arranca, y en producción tampoco sin
`CORS_ORIGINS`. Las variables están documentadas en [.env.example](.env.example).

## Comandos

| Comando                                                      | Qué hace                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `npm test`                                                   | Pruebas (`node:test`); nunca tocan la base: `test/setup.ts` fuerza una `DATABASE_URL` inalcanzable |
| `npm run build`                                              | `tsc` → `dist/` (type checking)                                                                    |
| `npx eslint .`                                               | Lint                                                                                               |
| `npm run format:check`                                       | Prettier (excluye lo generado, ver `.prettierignore`)                                              |
| `npm run db:generate`                                        | Genera la migración SQL a partir de `src/db/schema.ts`                                             |
| `npx drizzle-kit check`                                      | Valida la consistencia de las migraciones (sin conexión)                                           |
| `npm run db:migrate`                                         | Aplica migraciones en Neon (**escribe en la base: solo con autorización**)                         |
| `npm run tenant:create -- --name= --email= --adminPassword=` | Alta de agencia + usuario ADMIN (escribe en Neon)                                                  |
| `npm run vehicle-templates:sync`                             | Sincroniza el catálogo global de vehículos (escribe en Neon)                                       |

## Arquitectura en una línea

Monolito modular: `src/modules/<dominio>/{routes,schema,service}.ts`. La ruta valida con Zod y toma el
`agencyId` de la sesión, el servicio aplica las reglas (transacción y candados `FOR UPDATE` si toca
dinero o cupo) y los errores de dominio (`NotFoundError` 404, `BusinessRuleError` 400,
`ConflictError` 409) los traduce un manejador global; cualquier otro error es un 500 genérico.
Código compartido en `src/shared/` (reglas puras, errores, seguridad, almacenamiento de archivos).
