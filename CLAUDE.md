# tripagent-api — Memoria técnica del backend

> Contexto global (producto, contrato front-back, reglas transversales, reglas de desarrollo, deuda conocida) en `../CLAUDE.md`. Si este repo se abre solo, lee ese archivo si existe.
> Este es un repo Git independiente. No hagas commit, push ni pull sin que el usuario lo pida.

## Stack

| Pieza | Versión (package.json) | Uso |
|---|---|---|
| Node + TypeScript | TS ^5.7, ESM (`"type": "module"`) | `tsconfig`: `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| Fastify | ^5.12.7 | Servidor HTTP (actualizado el 2026-11-13 por advisories de seguridad) |
| fastify-type-provider-zod + Zod | ^7 / ^4.6.7 | Validación de params, query y body, y tipado de `request` |
| Drizzle ORM / drizzle-kit | ^0.45 / ^0.31 | ORM, query API relacional y migraciones |
| postgres (postgres.js) | ^3.4 | Driver hacia Neon (`ssl: "require"`, pool de 10) |
| @fastify/jwt + @fastify/cookie | ^10 / ^11 | JWT en la cookie `token` |
| @fastify/cors, @fastify/multipart, @fastify/static | — | CORS, subida de PDF (≤5 MB, 1 archivo), servir `public/` |
| @fastify/rate-limit | ^11.2.1 | Límite de intentos por ruta (`global: false`, almacén en memoria) |
| bcryptjs | ^3 | Hash de contraseñas (salt 12) |
| tsx | ^4 | Ejecución en desarrollo y scripts |
| libphonenumber-js | 1.13.15 (exacta) | Teléfonos internacionales: validación y E.164 (`shared/utils/phone.util.ts`; la misma versión en el front). Fija: la 1.13.16 tenía menos de dos semanas el 2026-11-16 |

Skills de agente instalados en `.agents/skills/` (`neon`, `neon-postgres`; ver `skills-lock.json`).

## Scripts

```
npm run dev            # tsx watch src/server.ts  (puerto PORT, por defecto 3001; host 0.0.0.0)
npm run build          # tsc → dist/
npm start              # node dist/server.js
npm run db:generate    # drizzle-kit generate (crea SQL en ./drizzle a partir de schema.ts)
npm run db:migrate     # aplica migraciones (src/db/migrate.ts) — escribe en Neon
npm run db:push        # drizzle-kit push — evitar; el flujo del repo es generate + migrate
npm run tenant:create -- --name= --email= --adminPassword= [--phone= --phoneCountry=MX --adminName=]   # el logo se sube desde Configuración (POST /agencies/logo)
npm run vehicle-templates:sync  # catálogo versionado → tabla vehicle_templates (idempotente; escribe en Neon)
npm run phones:normalize        # reporte de teléfonos por convertir a E.164 (lee Neon); con `-- --apply` respalda y convierte (escribe en Neon)
npm run format / format:check
npm test               # node:test + tsx sobre test/**/*.test.ts (sin dependencias extra)
```

No hay script de lint (usa `npx eslint .`). `.prettierignore` excluye lo generado (`drizzle/meta/`, `dist/`), así que `format:check` solo revisa código propio. `npx drizzle-kit check` valida la consistencia de las migraciones sin conectarse a la base.

**Pruebas** (`test/`, fuera de `src/`, así que `tsc` no las compila):

- `test/setup.ts` se carga con `--import` y **fuerza una `DATABASE_URL` inalcanzable**, de modo que ninguna prueba toca Neon. Toda consulta debe simularse.
- Las rutas reales se prueban con `buildApp()` + `app.inject()`. Las sesiones se generan con `sessionCookie()` y los servicios o `db.query.*` se simulan con `mock.method` de `node:test`.
- `rowMatches()` de `test/helpers.ts` evalúa un `where` de Drizzle (solo `and(eq…)`), lo que permite comprobar si una consulta filtra por `agencyId`.
- `chain(result)` simula un query builder encadenado (`select/update/delete/insert`) para transacciones falsas.
- Cobertura actual: `agencies.test.ts`, `tours-public.test.ts`, `tour-seats.test.ts`, `lookup-traveler.test.ts`, `booking-passengers.test.ts` y `tenant-ownership.test.ts` (quick-booking y assignVehicle), `booking-rules.test.ts`, `booking-confirmation.test.ts` (PENDING ⇄ CONFIRMED vía pagos y anulaciones), `dashboard-seat-right.test.ts`, `magic-link-portal.test.ts`, `booking-capacity.test.ts` (cupo vendible y 409 en apartado rápido, pre-reserva y agregar lugar) `booking-transfer.test.ts` (transferencia de titular y acompañante, regeneración del token, herencia de abordaje, 409 y 404) y `tour-lifecycle.test.ts` (capacidad vendible no menor que los ocupados al editar, borrado protegido, moneda/precio congelados, PATCH parcial sin defaults, resincronización por anticipo, candado del vehículo y `releasedSeats`, tope de bloqueos de staff, limpieza de `seatLabel` en `cancel-full`) `agencies.test.ts` también cubre `PATCH /agencies` (tarjeta vacía → null, sin enviar → sin cambio, < 16 dígitos → 400, dirección null) y `PATCH /agencies/policies` (401, texto recortado, vacío → null, > 5000 → 400); `tour-lifecycle.test.ts` las políticas del tour; `auth-me.test.ts` (`agencyLogoPath`), `agency-branding.test.ts` (GET con colores por defecto, PATCH con normalización hex y 400, logo PNG guardado en disco, SVG y > 2 MB rechazados sin dejar archivo, DELETE que borra el archivo y CORS del logo en `/public`) y `vehicle-templates.test.ts` (los tres croquis del catálogo y su numeración, capacidad sin operador, formato anterior, `GET /vehicle-templates`, asignación con `templateId` find-or-create, candado con asientos de pasajero, asiento de staff y etiquetas fuera del croquis). `tours-public.test.ts` cubre también `availability`, incluido `hasDeparted` en un tour que ya salió. `dashboard-seat-right.test.ts` cubre `bookedAt`. `error-handler.test.ts` (manejador global: 404/400/409, 500 sin SQL, validación con su formato); `privacy-and-sessions.test.ts` (`fillEmptyTravelerFields`, registro sin aviso → 400, registro que no sobrescribe nombre ni correo y guarda la aceptación, usuario desactivado → 401); `tour-cancellation.test.ts` (regla del estado CANCELADO, `summarizeRefunds`, `POST /tours/:id/cancel` con 200/409/404/400, abono rechazado y reembolsos con tope y REFUNDED, Magic Link cancelado sin la nota interna); `dashboard-seat-right.test.ts` cubre `cancellation` y `refunds` (anulación ≠ devolución). `security.test.ts` (auditoría 2026-11-13): secretos obligatorios, CORS por lista, encabezados, login sin enumeración y sin SQL en el 500, cookie de 1 día, 429 en login y pre-reserva, y registro del Magic Link rechazado (409, sin escrituras) si la reserva ya no está en `AWAITING_REGISTRATION`; un 500 nunca expone el texto interno (ni SQL de Drizzle ni el mensaje de un `Error` genérico). `lookup-traveler.test.ts` cubre `findRegistrationContext` (solo con la reserva en `AWAITING_REGISTRATION`). `financial-flows.test.ts` cubre los 4 escenarios de la baja con retención (FLUJO-RES-004), el 400 por retención mayor al lugar y la devolución del saldo a favor; `booking-rules.test.ts` cubre `summarizeCompanionDrop` y `dashboard-seat-right.test.ts` los campos nuevos del dashboard. `audit-mode.test.ts` (OBS-004, 2026-11-17): con la base en memoria, cada mutación del operador en un tour FINALIZADO y en uno CANCELADO responde 409 sin escribir (abono, anulación, apartado rápido, agregar y liberar lugar, baja, cancelación total y por porcentaje, transferencia, bloquear y liberar asiento, editar el tour y cambiar el folleto); un tour EN CURSO sigue aceptando abonos y bajas; `tour-lifecycle.test.ts` cubre el vehículo. `phone-international.test.ts` (2026-11-16): `normalizePhone` (nacional, internacional, formatos anteriores, lada distinta al país), candidatos de búsqueda, `isSamePhone`, `confirmLegacyPhone`, país de emergencia, E.164 + país en el apartado rápido (Canadá con +1), 10 dígitos de un cliente anterior, 400 por lada/país/número inválidos y 409 al editar un viajero con el número de otro en el formato anterior; `booking-transfer.test.ts` también cubre que el mismo número en E.164 no regenera el token. `architecture-audit.test.ts` (auditoría 2026-11-15): `brochureUrl` ya no es escribible, `removeUpload` con prefijo no borra archivos de otro tour, folleto de un tour ajeno → 404 sin escribir, PDF/PNG falsos (firma) → 400 sin dejar archivo, PDF válido borra el folleto anterior, `POST /bookings` y `POST /agencies` → 404, doble anulación → 409 con candado `FOR UPDATE`, reserva ajena → 404 desde el candado, asiento a un pasajero de una reserva cancelada → 404, etiqueta > 10 → 400, dashboard y manifiesto de un tour ajeno → 404, `equivalentMXN` con reembolso y `PATCH /bookings/:id/cancel` (%) que libera asientos.
- Los archivos de prueba corren **en paralelo** (un proceso por archivo): una prueba que escriba en `public/uploads/` debe usar prefijos propios (otro tour u otra agencia) para no alterar los conteos de otro archivo.

Variables de entorno (`.env`):

- `DATABASE_URL`: obligatoria; sin ella el servidor lanza un error al arrancar.
- `PORT`: puerto HTTP (por defecto 3001; el front apunta a `http://localhost:3001/api`). Hasta el 2026-11-15 el servidor la ignoraba.
- `DB_POOL_MAX` (opcional, por defecto 10): conexiones del pool de Postgres **por instancia**. Con varias instancias, usa el endpoint con pooler de Neon (host con `-pooler`) y reparte el límite.
- `JWT_SECRET` y `COOKIE_SECRET`: **obligatorias** (≥ 32 caracteres y distintas); sin ellas `buildApp()` lanza `SecurityConfigError` y la API no arranca. Ya no hay valores por defecto en el código. Cambiarlas invalida todas las sesiones.
- `CORS_ORIGINS` (lista separada por comas): orígenes del front con credenciales. **Obligatoria con `NODE_ENV=production`**; en desarrollo, sin ella, se permiten localhost y redes privadas (192.168.x.x, 10.x.x.x, 172.16–31.x.x).
- `TRUST_PROXY` (opcional): saltos de proxy de confianza ("1") o IPs/CIDR, para que `request.ip` (y el límite de intentos) use la IP real detrás de un balanceador.
- `NODE_ENV=production` activa la cookie `Secure` y HSTS.
- Plantilla sin valores: [.env.example](.env.example). Las pruebas fijan secretos de prueba en `test/setup.ts`.

## Estructura

```
src/
├── app.ts                    # buildApp(): plugins, decorador authenticate, CORS, registro de módulos
├── server.ts                 # Solo arranque: buildApp() + listen(PORT) + apagado ordenado (SIGTERM/SIGINT cierra Fastify y el pool)
├── types/fastify.d.ts        # Tipos de request.user {id, agencyId, role}, app.authenticate, request.file()
├── db/
│   ├── index.ts              # export const db = drizzle(postgres(DATABASE_URL, { max: DB_POOL_MAX }), { schema }) + closeDb()
│   ├── schema.ts             # ★ Tablas, enums y relaciones (fuente de verdad del modelo)
│   ├── migrate.ts            # Runner de migraciones
│   ├── seed-admin.ts         # CLI tenant:create (agencia + ADMIN; ya no copia vehículos)
│   ├── sync-vehicle-templates.ts # CLI vehicle-templates:sync (upsert por code; rechaza cambiar un croquis)
│   ├── normalize-phones.ts   # CLI phones:normalize (10 dígitos → E.164 con respaldo; regla 21 de ../CLAUDE.md)
│   └── catalog/vehicle-templates.catalog.ts # ★ Catálogo versionado: SPRINTER_20, BUS_48_WC, BUS_50_WC
├── shared/constants/
│   └── domain.constants.ts   # Enums del contrato que NO son de BD: PASSENGER_ROLES / PassengerRole / PASSENGER_ROLE (TITULAR, COMPANION) y TOUR_TEMPORAL_STATUSES / TOUR_TEMPORAL_STATUS (PRÓXIMO, EN CURSO, FINALIZADO, CANCELADO; lo devuelve getTourTemporalStatus). Los enums de BD siguen en db/schema.ts
├── shared/schemas/
│   ├── policies.schema.ts    # policiesTextSchema + POLICIES_MAX_LENGTH (5000): políticas generales de la agencia
│   └── phone.schema.ts       # phoneSchema / optionalPhoneSchema (→ E.164), phoneCountrySchema (ISO alfa-2) y refinePhoneCountry (lada = país)
├── shared/errors/
│   └── domain-errors.ts      # NotFoundError (→ 404), BusinessRuleError (→ 400), ConflictError y CapacityExceededError (→ 409); los traduce app.setErrorHandler
├── shared/security/          # security.config.ts (secretos, CORS, trustProxy), rate-limits.ts, error-message.util.ts (GENERIC_ERROR_MESSAGE)
├── shared/storage/
│   └── uploads.ts            # ★ Archivos subidos: UPLOAD_DIRS, writeUpload, hasFileSignature (magic bytes), removeUpload (con prefijo), toPublicUploadPath
├── shared/utils/
│   ├── tour-audit-mode.util.ts # ★ assertTourNotInAuditMode(tour): 409 en un tour FINALIZADO o CANCELADO (Modo Auditoría, regla 9 de ../CLAUDE.md)
│   ├── tour-status.util.ts   # getTourTemporalStatus(departureDate, cancelledAt, returnDate) (PRÓXIMO / EN CURSO / FINALIZADO / CANCELADO) y getTourLastActiveDate (último día EN CURSO: regreso, o salida + 1 sin regreso)
│   ├── refund.util.ts        # ★ summarizeRefunds (saldo a reembolsar, estado de la devolución) e isVoidEntry
│   ├── phone.util.ts         # ★ normalizePhone (→ E.164; sin "+" ni país = México), phoneLookupCandidates (E.164 + formatos anteriores), isSamePhone
│   ├── traveler-merge.util.ts # fillEmptyTravelerFields (registro: solo campos vacíos) y confirmLegacyPhone (confirma la lada de un registro anterior)
│   ├── booking-rules.util.ts # ★ Reglas puras: tamaño de grupo, anticipo requerido, isDepositCovered, calculateBookingStatus, getSellableCapacity, resolveAgreedUnitPrice, summarizeCompanionDrop (baja con retención), getRetainedPenaltyTotal y getRefundableSurplus
│   └── vehicle-layout.util.ts # ★ Croquis: layoutMapSchema (Zod), getLayoutSeats, getLayoutSeatLabels, getVehicleCapacity
├── modules/bookings/booking-lock.util.ts # lockBookingForUpdate(tx, bookingId, agencyId): SELECT … FOR UPDATE de la reserva (+ pertenencia → 404)
└── modules/<dominio>/
    ├── <dominio>.routes.ts   # "controlador": define rutas, auth y schema; los errores los traduce el manejador global
    ├── <dominio>.schema.ts   # Schemas Zod + tipos inferidos (z.infer)
    └── <dominio>.service.ts  # Clase con métodos estáticos; lógica + Drizzle
drizzle/                      # 0000…0034 *.sql + meta/ (generado; no editar a mano). 0025 = vehicle_templates + vehicles.template_id. 0026 = agency_branding + rename agencies.logo_url → logo_path (con un UPDATE agregado a mano que deja en NULL las URLs de ejemplo que no eran archivos). 0027 = agencies.policies + tours.policies (aplicada). 0028 = tours.cancelled_at / cancellation_reason / cancellation_note (aplicada en Neon el 2026-11-14). 0029 = DROP tours.policies (aplicada el 2026-11-14). 0030 = agencies.privacy_notice_url + bookings.privacy_notice_accepted_at (aplicada el 2026-11-14). 0031 = índices de rendimiento (solo `CREATE INDEX`, ver "Escalabilidad"; aplicada en Neon el 2026-11-16). 0032 = DROP tours.is_active + DROP TYPE seat_status (aplicada en Neon el 2026-11-16). 0033 = agencies.phone_country + travelers.whatsapp_country / emergency_contact_country (teléfonos internacionales; aplicada en Neon el 2026-11-16; falta `phones:normalize`, ver sección G de `../CLAUDE.md`). 0034 = bookings.unit_price, precio pactado por lugar, con el llenado de las reservas existentes (aplicada en Neon el 2026-11-17). Las 35 migraciones del journal están aplicadas
public/uploads/brochures/     # PDFs subidos (servidos en /public/uploads/brochures/…; en .gitignore)
public/uploads/logos/         # Logotipos de agencias, PNG/JPEG (servidos en /public/uploads/logos/…; en .gitignore)
```

Hay una excepción al patrón: `bookings/booking.routes.ts`, `booking.schema.ts` y `booking.service.ts` usan nombres en singular.

## Arquitectura y patrones

- **Capas:** route → service → `db` (monolito modular). No hay repositorios, controladores en clases ni inyección de dependencias. Los servicios importan `db` directamente. **Decisión (auditoría 2026-11-15):** se conserva. Clean/Hexagonal/DDD o una capa de repositorios no resolverían un problema real hoy: las pruebas ya aíslan la base con `mock.method` sobre `db`/servicios, y cada módulo es cohesivo. Revisar si aparece un segundo almacenamiento (p. ej. caché o nube) o un worker que comparta lógica.
- **Flujo de una petición:** `onRequest` (`app.authenticate`: JWT de la cookie + usuario activo) → validación Zod (`params/querystring/body`; 400 automático) → `preHandler` (límite de intentos que usa el body) → handler de la ruta (toma `agencyId` de `request.user`) → servicio (transacción si toca dinero/cupo) → respuesta. Cualquier error lanzado sube a `app.setErrorHandler`.
- **Una ruta típica:**
  ```ts
  export async function xRoutes(app: FastifyInstance) {
    const server = app.withTypeProvider<ZodTypeProvider>();
    server.post(
      "/:id/accion",
      { onRequest: [app.authenticate], schema: { params, body } },
      async (request, reply) => {
        // Sin try/catch: los errores de dominio (NotFound/BusinessRule/Conflict) y los 500 los
        // traduce el manejador global de app.ts. Solo atrapa lo específico de la ruta (p. ej. 23505).
        const { agencyId, id: userId } = request.user;
        const result = await XService.accion(request.params.id, request.body, agencyId);
        return reply.status(200).send({ success: true, data: result });
      },
    );
  }
  ```
- **Servicios:** `export class XService { static async metodo(..., agencyId) }`. Las operaciones que tocan dinero, cupo o varias tablas van en `db.transaction(async (tx) => …)` y usan siempre `tx` adentro. Las validaciones de negocio lanzan **errores de dominio** (`NotFoundError`, `BusinessRuleError`, `ConflictError`) con el mensaje en español; un `throw new Error(...)` genérico es un fallo interno y el cliente solo verá "Error interno del servidor".
- **Concurrencia (candados `FOR UPDATE`):** con READ COMMITTED, toda mutación que lee y reescribe un agregado bloquea su fila primero. Tour: cupo (`assertSeatsAvailable`), editar/cancelar/borrar, vehículo y **asientos** (`updateSeatStatus`). Reserva (`lockBookingForUpdate`): abonos, reembolsos, anulaciones, `cancel-full`, `cancel` (%), `pending-slots`, baja de pasajero y `add-passenger`. **Orden fijo tour → reserva** (`add-passenger` bloquea el tour en `assertSeatsAvailable` y después la reserva; `cancelTour` bloquea el tour y luego actualiza sus reservas): no inviertas el orden o habrá interbloqueos.
- **Consultas:**
  - `db.query.<tabla>.findFirst/findMany({ where, with })` para lecturas con relaciones;
  - query builder (`select / insert / update … returning()`) para escrituras y agregados;
  - subconsultas SQL con `sql\`\``para métricas (ver`TravelerService.findTravelers`).
- **Montos:** las columnas `numeric(…, mode: "number")` se envuelven con `Number(...)` antes de operar. Para sumas se delega a SQL (`COALESCE(SUM(...),0)`).
- **Timestamps:** `mode: "string"`. Se asigna `updatedAt: new Date().toISOString()` a mano en los updates (no hay trigger).
- **Borrado lógico:** se asigna `deletedAt` y las lecturas filtran `isNull(x.deletedAt)`. No hay borrados físicos de tours ni viajeros (`deleteTour` y `deleteTraveler`, que borraban sin filtrar por agencia, se eliminaron el 2026-11-14).
- **Comentarios y mensajes en español.** Formato con Prettier (100 columnas, comillas dobles, trailing commas) y ESLint (`typescript-eslint` recommended; `no-explicit-any` y `no-unused-vars` en warn, ignora `_x`).
- **Imports** relativos con extensión `.js` (requisito de NodeNext), por ejemplo `../../db/index.js`.

## Autenticación, middlewares y validación ([src/app.ts](src/app.ts))

- **Orden de registro:** static → multipart → cookie → jwt (`cookie: { cookieName: "token" }`) → decorador `authenticate` → compiladores Zod → CORS → módulos.
- **`app.authenticate`** ejecuta `request.jwtVerify()` y, si falla, responde `401 { error: "No autorizado o sesión expirada" }`. Después confirma que el usuario siga activo (`isSessionActive`, por defecto `AuthService.isSessionActive`: `agency_users.isActive` del usuario y la agencia del token). Si no, responde `401 { error: INACTIVE_USER_MESSAGE }` (decisión del PM, 2026-11-14). `buildApp({ isSessionActive })` permite sustituirla; `createTestApp()` la deja en `true`. Se aplica por ruta con `onRequest` o `preHandler`. No hay hook global.
- **`request.user`** tiene la forma `{ id, agencyId, role }`. El `agencyId` se toma **solo** de aquí.
- **Roles:** no se comprueban en ningún lado.
- **Seguridad transversal** (`src/shared/security/`, auditoría 2026-11-13):
  - `security.config.ts`: `resolveSecrets` (secretos obligatorios), `resolveCorsOrigin` (lista `CORS_ORIGINS` o patrón de desarrollo) y `resolveTrustProxy`.
  - `rate-limits.ts`: `RATE_LIMITS` por ruta vía `config: { rateLimit: RATE_LIMITS.x }` — login 10/15 min por IP + correo (`hook: "preHandler"`, porque la clave usa el body), cambio de contraseña 5/15 min por usuario, pre-reserva 10/h, registro público 20/h, `lookup-traveler` 20/10 min y lecturas públicas (validate, folleto) 120/min por IP. 429 → `{ error: "Demasiados intentos. Vuelve a intentarlo en N minutos." }`. Toda ruta pública nueva debe declarar su límite.
  - `error-message.util.ts`: `GENERIC_ERROR_MESSAGE` ("Error interno del servidor"), el texto de todo 500. `toClientErrorMessage` se eliminó el 2026-11-15: dejaba pasar el texto de cualquier `Error` que no pareciera de base de datos.
  - Hook `onSend` global: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y HSTS en producción.
- **Login** (`auth.service.ts`): correo inexistente → se compara contra un hash bcrypt de relleno (mismo costo 12) para que el tiempo no revele qué correos existen; mismo mensaje "Credenciales inválidas". Errores internos → 500 genérico. JWT y cookie duran 1 día (`SESSION_TTL_SECONDS`).
- **CORS:** `origin: resolveCorsOrigin()` (antes `origin: true`, que reflejaba cualquier origen), `credentials: true`.
- **Validación:** schemas Zod en `schema: { params, querystring, body }`. Un fallo de validación devuelve un 400 automático de Fastify con `message` e `issues`. No se usan schemas de `response`.
- **Errores** (auditoría de arquitectura, 2026-11-14): `app.setErrorHandler` traduce los errores de dominio de `shared/errors/domain-errors.ts`: `NotFoundError` → 404, `BusinessRuleError` → 400, `ConflictError` (y `CapacityExceededError`) → 409, siempre con `{ error: mensaje }`. Los 4xx propios de Fastify (validación con `issues`, 429, archivo demasiado grande) pasan al manejador por defecto con su formato. Cualquier otro error es un 500 con `GENERIC_ERROR_MESSAGE` (falla cerrado desde el 2026-11-15: ni SQL ni el texto de un `Error` genérico) y el detalle se registra en el log.
  - **Nunca compares el texto del mensaje** para decidir el código: lanza el error tipado desde el servicio.
  - Las rutas no necesitan `try/catch` (desde el 2026-11-15 ninguna compara textos ni arma 500 a mano). Solo lo conservan las que traducen algo propio: códigos de Postgres `23505` (unique) → 409 y `23503` (FK) → 409/400, o `FST_REQ_FILE_TOO_LARGE` → 400 en las subidas. Lo que no reconozcan lo relanzan (`throw error`). Excepción: `GET /magic-tokens/:token/validate` responde su 500 con el formato del Magic Link (`{ isValid, error: { code, message } }`).

  Formato de error: `{ error: string }`. Formatos de éxito (no son uniformes; el front desenvuelve `.data`): `{ data }`, `{ success, data }`, `{ data, pagination }` o el objeto directo.

## Modelo de datos ([src/db/schema.ts](src/db/schema.ts))

```
agencies 1─* agency_users
agencies 1─1 agency_branding (colores de marca; cascade)
agencies 1─* travelers, tours, bookings, payments, vehicles, magic_tokens
vehicle_templates 1─* vehicles (vehicles.templateId, set null; único por agencia + plantilla)   ← catálogo GLOBAL, sin agencyId
vehicles 1─* tours (tours.vehicleId, set null)
tours 1─* bookings ─* booking_passengers *─1 travelers
bookings 1─1 magic_tokens (magicTokens.bookingId)     bookings 1─* payments
tours 1─* tour_blocked_seats (unique tourId+seatLabel)
```

**Puntos clave:**

| Tabla | Detalles |
|---|---|
| `agencies` | Datos bancarios: `bankName`, `bankAccountHolder`, `clabeNumber` (18, obligatoria en el body), `cardNumber` (16, **opcional** desde el 2026-11-14: `""` o `null` → `null`; sin enviar → no cambia). `address` acepta `null` en `PATCH /agencies` (antes respondía 400 y una agencia sin dirección no podía guardar ningún dato). `policies` (text nulo, ≤ 5000: políticas generales; `PATCH /agencies/policies`). `logoPath` (columna `logo_path`, antes `logo_url`): ruta del archivo del logotipo en `public/` (`/uploads/logos/…`), no una URL; solo la escriben `POST/DELETE /agencies/logo` (ya no está en el body de `POST/PATCH /agencies`). `subscriptionStatus` (trialing por defecto), `trialEndsAt` |
| `agency_branding` | 1:1 con `agencies` (`agencyId` único). `primaryColor` (default `#4f46e5`), `secondaryColor` (default `#4338ca`), `accentColor` (nullable), hex `varchar(7)`. Sin fila → defaults vía `AgencyBrandingService.resolveColors`. Solo colores: el logo vive en `agencies.logoPath` |
| `travelers` | Teléfonos en E.164 + país (`whatsappCountry`, `emergencyContactCountry`; nulo = lada sin confirmar; regla 21 de `../CLAUDE.md`). Las búsquedas por WhatsApp usan `inArray(whatsappPhone, phoneLookupCandidates(e164))`; `TravelerService` revisa el número en todos sus formatos antes de crear o editar (409), porque el índice no detecta `+522281234567` = `2281234567`. Índice único parcial `(agencyId, whatsappPhone)` cuando el teléfono no es nulo y no está borrado (las búsquedas por WhatsApp del registro y la transferencia también filtran `deletedAt` nulo, desde el 2026-11-15). `customFields` jsonb |
| `tours` | `cancelledAt` / `cancellationReason` / `cancellationNote` (cancelación por la agencia, regla 18; CANCELADO = `cancelledAt` no nulo). Sin `isActive` desde el 2026-11-16 ("Pausado" no existe; la migración `0032`, aplicada el 2026-11-16, borró la columna). `price`, `depositPerPerson`, `currency`, `maxCapacity` (capacidad total del vehículo), `staffCapacity` (lugares de staff, no vendibles; default 0; capacidad vendible = `maxCapacity − staffCapacity`), `transportModality`, banderas `acceptsBankTransfer`, `acceptsCreditCard` (+`paymentLink`) y `acceptsCash` (+`cashInstructions`). `boardingPoints` jsonb `{id,time,location}[]`, `brochureUrl` (`/uploads/brochures/…`), `postPaymentInstructions` (indicaciones de logística; Magic Link y dashboard las envían recortadas, vacío → `null`). Sin `policies`: los tours no tienen políticas propias y la columna se eliminó con la migración `0029` (2026-11-14). `createdByUserId` y `updatedByUserId` existen, pero no se llenan |
| `bookings` | `status`, `paymentStatus`, `totalPrice`, `unitPrice` (precio pactado por lugar, migración `0034`), `amountPaid`, `groupReference` (`GRP-XXXXXXXX`), `lastPaymentMethod`. Índice único parcial `(tourId, travelerId)` cuando `status <> CANCELLED` |
| `booking_passengers` | `isTitular`, `passengerType`, `boardingPoint` (texto libre: id, ubicación o `"ubicación (hora)"`), `status`, `seatLabel`, `seatAssignedAt` y `seatAssignedByUserId` (no se llenan). Índice único parcial `(bookingId, travelerId)` cuando no está CANCELLED |
| `magic_tokens` | `token` único (`randomUUID` sin guiones), `numberPassengers` (tamaño esperado del grupo), `currentUses`, `expiresAt` (se guarda, pero **no se valida**: el enlace no vence por decisión del PM) |
| `payments` | `type`, `method`, `amount` (negativo en REFUND), `currency`, `collectedAmount`, `collectedCurrency`, `exchangeRate` (escala 4), `referenceInfo`, `createdByUserId` |
| `vehicle_templates` | Catálogo global: `code` único, `name`, `description`, `layoutMap`, `isActive`, `sortOrder`. Se llena solo con `vehicle-templates:sync`; inmutable por `code` |
| `vehicles` | Unidad de la agencia. `templateId` (nulo en vehículos anteriores al catálogo o creados por API), `layoutMap` = **copia** del croquis. Índice único parcial `(agencyId, templateId)` cuando `templateId` no es nulo. Formato del croquis en `shared/utils/vehicle-layout.util.ts` y regla 8 de `../CLAUDE.md` |

**Para cambiar el esquema:** edita `schema.ts`, ejecuta `npm run db:generate` y revisa el SQL generado. Después corre `npm run db:migrate`, solo con autorización.

## Módulos, endpoints y servicios

Prefijos registrados en `server.ts` (todos bajo `/api`):

| Módulo (carpeta) | Prefijo | Endpoints | Auth | Servicio y lógica principal |
|---|---|---|---|---|
| `auth` | `/auth` | `POST /login`, `GET /me`, `POST /logout`, `POST /change-password` | ✔ excepto login y logout | `AuthService`: bcrypt; `me` devuelve `agencyName` (respaldo `"Brujitours"`) y `agencyLogoPath` (o null) |
| `agencies` | `/agencies` | `GET /`, `PATCH /`, `GET /subscription`, `GET /:id`, `PATCH /policies`, `GET/PATCH /branding`, `POST/DELETE /logo` | ✔ (`/:id` responde 403 si `:id ≠ request.user.agencyId`) | `Agency` (sin alta por API: `POST /` se eliminó el 2026-11-15, porque no tenía consumidores y cualquier usuario podía crear agencias con `subscriptionStatus: "active"`; el alta es por CLI, `tenant:create`, con trial de 30 días). `PATCH /` (`updateAgencyBodySchema` = esquema base **sin** `subscriptionStatus` ni `isActive`, y sin `trialEndsAt`; desde el 2026-11-14 Zod descarta esas claves: antes cada guardado regresaba la agencia a `trialing` por el valor por defecto, y un operador podía activar su suscripción o extender su prueba. La facturación solo cambia por CLI). `AgencySubscriptionService` ([agency-subscription.service.ts](src/modules/agencies/agency-subscription.service.ts), `GET /subscription`, solo lectura; reglas puras en `shared/utils/subscription.util.ts` y canales de pago de TripAgent en las variables `SUBSCRIPTION_*`; regla 20 de `../CLAUDE.md`). `Agency.updatePolicies` (`PATCH /policies` `{ policies }` → `{ data: { policies } }`; el texto se lee con `GET /`). `AgencyBrandingService` ([agency-branding.service.ts](src/modules/agencies/agency-branding.service.ts)): `getBranding` → `{ logoPath, primaryColor, secondaryColor, accentColor }`; `updateColors` (upsert parcial; body `updateBrandingBodySchema`, hex `#RGB`/`#RRGGBB` normalizado a `#rrggbb`); `setLogoPath` (transacción con `FOR UPDATE`, devuelve la ruta anterior) y `removeLogoFile` (solo rutas `/uploads/logos/`). `POST /logo`: multipart con un archivo, PNG/JPEG declarado **y** con la firma real del formato (`hasFileSignature`; un SVG o HTML renombrado → 400), límite de 2 MB por petición (`FST_REQ_FILE_TOO_LARGE` → 400); escribe el archivo, actualiza la base y después borra el anterior (si algo falla, borra el nuevo) |
| `tours` | `/tours` | `GET /` (search, limit≤100, offset), `POST /`, `GET/PATCH/DELETE /:tourId`, `POST /:tourId/brochure`, `POST /` (400 si la salida es anterior a hoy en CDMX; `PATCH /:tourId` tampoco la mueve al pasado, aunque conserva una fecha guardada que ya pasó; 2026-11-17), `PATCH /:tourId/vehicle` `{ vehicleId }` (409 si el tour EN CURSO ya tiene unidad; petición del usuario, 2026-11-17; en FINALIZADO o CANCELADO, 409 siempre por el Modo Auditoría), `POST /:tourId/cancel` `{ reason, note? }` (`cancelTour`, regla 18 de `../CLAUDE.md`; 409 ya cancelado o finalizado) | ✔ | `TourService` (ver "Ciclo de vida del tour" abajo): el listado añade `temporalStatus`, `currentOccupancy` y `sellableCapacity` (vía `BookingCapacityService`); `GET /:tourId` añade `hasPayments` y `temporalStatus`; `updateTour` y `updateBrochureUrl` responden 409 en un tour FINALIZADO o CANCELADO (Modo Auditoría; la ruta del folleto borra el archivo recién escrito); create/update validan `staffCapacity < maxCapacity`; `brochureUrl` **no** está en los schemas de crear/editar (solo lo escribe la subida); `removeBrochure` borra el archivo después de confirmar la transacción y solo si se llama `tour-<id>-…` (`removeUpload` con `brochureFilePrefix`). `POST /:tourId/brochure`: verifica que el tour sea de la agencia **antes** de escribir (404), exige `application/pdf` y firma `%PDF-` (400 sin dejar archivo), actualiza la base y borra el folleto anterior del mismo tour |
| `tours-public` | `/api/tour-brochure` (registrado como `"api/tour-brochure"`; Fastify lo resuelve bien) | `GET /public/tours/:id` | público | `TourBrochure`: solo tours con `deletedAt` y `cancelledAt` nulos (los demás → 404; errores inesperados → 500 genérico). Proyección explícita (`columns`) con los campos que usa `/p/[id]` + `agency: {name, phone, logoPath}` + `availability: { sellableCapacity, occupiedSeats, availableSeats, isBookable, hasDeparted }`. `isBookable` es verdadero si el tour está PRÓXIMO y tiene lugares; `hasDeparted` si el estado temporal ya no es PRÓXIMO, en cuyo caso el folleto dice "Finalizado" (decisión del PM, 2026-11-13). Sin datos bancarios ni ids internos |
| `bookings` (público) | `/public` | `POST /pre-booking` `{ tourId, fullName, whatsapp, numberPassengers }` → 201 `{ success, message }` (sin token ni ids); 404 tour inexistente, borrado o pausado; 409 sin cupo, tour ya salido o WhatsApp ya inscrito | público | `booking-public.routes.ts` → `BookingService.createPublicPreBooking` |
| `bookings` | `/bookings` | `POST /public/register`, `POST /:id/quick-booking`, `PATCH /:id/cancel` (%), `PATCH /:id/cancel-full` (monto), `POST /:bookingId/add-passenger`, `DELETE /:bookingId/pending-slots`, `PATCH /:bookingId/transfer` | ✔ excepto public/register | `BookingService` (ver flujos abajo). `POST /` (registro de grupo con sesión) se eliminó el 2026-11-15: sin consumidores, se saltaba el aviso de privacidad obligatorio (regla 19) y no comparaba la agencia del token con la de la sesión |
| `booking-passengers` | `/bookingPassengers` | `PATCH /:bookingId/passengers/:travelerId/cancel` | ✔ | `BookingPassengerService.cancelPassenger` (único método; la cancelación total vive en `BookingService.cancelFullBooking`). El 2026-11-11 se eliminaron `addOrReactivatePassenger`, `substitutePassenger` y un `cancelFullBooking` duplicado, porque no tenían ruta ni consumidores |
| `payments` | `/payments` | `POST /:bookingId/payments`, `POST /:bookingId/payments/:paymentId/void` | ✔ | `PaymentService` (candado de la reserva; anular dos veces el mismo abono → 409) |
| `dashboards` | `/dashboards` | `GET /:id` | ✔ | `DashboardService.getTourDashboard`: BFF del Centro de Control (tour ajeno → 404; antes 500) |
| `tour-manifest` | `/manifest` | `GET /:tourId/` | ✔ | `TourManifestService`: pasajeros con pago, agrupados por punto de abordaje (tour ajeno → 404; antes 500) |
| `tour-seats` | `/seats` | `GET /:tourId/seats`, `PATCH /:tourId/seats/:seatLabel` `{status, passengerId}` | ✔ (tour de la agencia de la sesión, si no → 404) | `TourSeatsService`: verifica el tour, **bloquea su fila** (`FOR UPDATE`: dos asignaciones simultáneas de la misma etiqueta se serializan; no hay índice único por asiento), libera la etiqueta, borra el bloqueo y luego asigna o bloquea. `seatLabel` ≤ 10 caracteres (400). Solo se asigna a pasajeros `ACTIVE` de reservas no canceladas (desde el 2026-11-15; antes podía quedar asignado a un pasajero de una reserva cancelada). Si `passengerId` no pertenece al tour → 404; si su grupo no cubre el anticipo requerido → 409; `BLOCKED` con asientos de staff del croquis + bloqueos (en otras etiquetas) ya iguales a `staffCapacity` → `ConflictError` 409. Si el tour tiene vehículo: asignar o bloquear una etiqueta que no existe en el croquis → 404 ("Asiento X no encontrado en el vehículo"; liberar sí se permite) y asignar o bloquear un asiento `kind: "STAFF"` → 409. Las validaciones ocurren antes de cualquier escritura. Bloquear un asiento ocupado (solo por API) sigue liberando al pasajero |
| `vehicles` | `/vehicles` | `GET /` (array; cada unidad con `templateId` y `capacity { total, passenger, staff }`), `POST /` (valida el croquis con `layoutMapSchema`) | ✔ | `VehiclesService` |
| `vehicle-templates` | `/vehicle-templates` | `GET /` → `{ data: [{ id, code, name, description, layoutMap, capacity }] }` (solo activas, por `sortOrder`) | ✔ | `VehicleTemplatesService`: `findActiveTemplates` y `findOrCreateAgencyVehicle(tx, templateId, agencyId)` (copia nombre y croquis; `ON CONFLICT DO NOTHING` + relectura ante concurrencia; plantilla inexistente o inactiva → "Plantilla de vehículo no encontrada", 404) |
| `travelers` | `/travelers` | `GET /` (search, paginado; con `tripCount`, `nextTourName/Date`, `hasNational/InternationalTrips`), `POST /`, `GET/PATCH/DELETE /:travelerId`, `GET /:travelerId/history` (métricas: `totalTrips`, `lifetimeValue`, `isHabitualCompanion`; cada viaje trae `returnDate` y `temporalStatus` con `getTourTemporalStatus`, sin `cancelledAt`, desde el 2026-11-16; viajero ajeno → 404, antes 400) | ✔ | `TravelerService`. `POST /` con WhatsApp duplicado → 409 "Ya existe un viajero registrado con ese WhatsApp" |
| `magic-tokens` | `/magic-tokens` | `GET /:token/validate`, `GET /:token/lookup-traveler?phone=` | público | `MagicTokenService.validate`: máquina de estados `flowState` y payload distinto por vista. `lookup-traveler` responde `{ fullName, email, emergencyContactName, emergencyContactPhone, birthDate }` (sin notas médicas) y **solo mientras la reserva del token está en `AWAITING_REGISTRATION`** (`MagicTokenService.findRegistrationContext`, consulta ligera; si no → 400 "Token inválido o expirado"). Desde el 2026-11-15: el enlace no vence y el registro se acepta una vez, así que después la búsqueda solo servía para enumerar clientes |

### Flujos de lógica clave (archivos de referencia)

**`BookingService.createQuickBooking`** ([booking.service.ts](src/modules/bookings/booking.service.ts)), en una transacción:

1. Busca el tour filtrando por `agencyId` de la sesión (si no, `Tour no encontrado` → 404).
2. Delega en `BookingService.reserveSeats(tx, tour, datos)`, que comparte con `createPublicPreBooking`:
   1. `BookingCapacityService.assertSeatsAvailable`: bloquea la fila del tour (`FOR UPDATE`), suma los lugares ocupados y lanza `CapacityExceededError` (→ 409) si `vendible − ocupados < N`.
   2. Busca o crea al titular por WhatsApp (un viajero existente **no** se modifica).
   3. Impide que el viajero ya esté en el tour (`ConflictError` → 409).
   4. Crea la reserva con `AWAITING_REGISTRATION` y `totalPrice = price × N`, inserta al titular en `booking_passengers` y crea el `magic_token` (`currentUses = 1`; `expiresAt` = +48 h, que no se valida).
3. Devuelve `{ bookingId, token, availableSeats }`.

**`BookingService.createPublicPreBooking`** (folleto, sin sesión): busca el tour por id con `deletedAt` y `cancelledAt` nulos (si no, 404), rechaza tours que ya no están PRÓXIMOS (409) y llama a `reserveSeats` con el `agencyId` **del tour** y sin email. No devuelve el token.

**Cupo** ([booking-capacity.service.ts](src/modules/bookings/booking-capacity.service.ts)): `getOccupiedSeats(executor, tourId, tourPrice)` es la única implementación de "lugares ocupados" (regla 12 de `../CLAUDE.md`). La usan `reserveSeats`, `addPassengerToBooking`, el dashboard, el listado de tours y el folleto. Cualquier flujo nuevo que **aumente** lugares debe llamar a `assertSeatsAvailable` dentro de su transacción.

**`BookingService.processGroupBooking`** (registro público con token):

1. Valida que el token exista y que el número de pasajeros no supere `numberPassengers`. **No revisa la expiración.** La ruta pública usa `publicRegisterBodySchema`, que exige `privacyNoticeAccepted: true` (400 si no); la fecha se guarda en `bookings.privacyNoticeAcceptedAt`. El payload `PENDING_REGISTRATION` de `GET /magic-tokens/:token/validate` incluye `agencyPrivacyNoticeUrl` y `agencyPolicies` (texto recortado o `null`) para el modal de políticas.
   - **Solo una vez** (auditoría 2026-11-13): si la reserva ya no está en `AWAITING_REGISTRATION` lanza `ConflictError` → 409 "Esta reserva ya fue registrada…" sin escribir nada. Como el enlace no vence, sin este candado se podía reenviar el registro (incluso pagado) para reasignar al titular, sobrescribir datos de otro cliente por WhatsApp o exceder los lugares apartados.
2. Crea al titular o, si ya existía (mismo WhatsApp, no borrado), **solo completa sus campos vacíos** (`fillEmptyTravelerFields`; decisión del PM, 2026-11-14). Fija su punto de abordaje.
3. Crea a los acompañantes en modo `MANUAL`; a los que ya existían solo les completa campos vacíos (`SHARE_LINK` existe en el schema, pero no tiene lógica).
4. Impide que un acompañante esté en otra reserva del tour (`ConflictError` → 409). Token inexistente → 404; más pasajeros que lugares apartados → 400 (antes todo era 500).
5. Incrementa `currentUses` y llama a `BookingStatusService.syncStatus(tx, id, { formCompleted: true })` (queda `PENDING` o, si ya cubría el anticipo, `CONFIRMED`).
6. Devuelve el payload de `BookingSuccessView`.

**Ajustes al grupo:**

| Método | Efecto |
|---|---|
| `addPassengerToBooking` | Usa el tour de la reserva (si el `tourId` del body no coincide → 400). Valida cupo con `assertSeatsAvailable(…, 1)` (→ 409; bloquea el tour), después bloquea la reserva y relee su total. +precio pactado de la reserva (`resolveAgreedUnitPrice`; antes `tour.price`, que pudo cambiar antes del primer abono) y `numberPassengers + 1` |
| `removePendingSlot` | −precio pactado (`resolveAgreedUnitPrice`), solo si hay lugares sin registrar |
| `cancelFullBooking` | Total = penalización, entre lo abonado (`assertClientRetention`: cuando cancela el cliente la agencia retiene lo pagado, 400 si es menor; 2026-11-17) y el total (o lo abonado, si una reserva anterior se pagó de más). Los pasajeros pasan a CANCELLED con `seatLabel = null`. `cancelTour` usa `applyFullCancellation` sin esa validación (retención $0) |
| `cancelBooking` (%) | Variante por porcentaje; sin uso en el front. Desde el 2026-11-15 delega en `applyFullCancellation` con penalización = total × % / 100 (antes duplicaba la lógica y **no liberaba los asientos**); 404 reserva ajena, 409 ya cancelada |
| `transferPassenger` | Re-vincula el lugar a otro viajero (find-or-create por WhatsApp; el original no se modifica). Titular: cambia `bookings.travelerId` (herencia de saldo) y, si el WhatsApp cambia, regenera `magic_tokens.token`. No toca dinero, cupo ni asiento, así que no llama a `syncStatus`. Regla 14 de `../CLAUDE.md` |
| `BookingPassengerService.cancelPassenger` | Retención para la agencia `penaltyAmount` (0 … precio pactado; mayor → 400, FLUJO-RES-004 / PQ-C5). Nuevo total = total − precio pactado + retención (`summarizeCompanionDrop`), con el precio de `resolveAgreedUnitPrice` (`bookings.unitPrice`; respaldo total ÷ lugares apartados). Lo abonado no cambia y el excedente ya no se retiene: queda como `refundableSurplus` (2026-11-17). Devuelve `financialSummary { previousTotal, newTotal, unitPrice, penaltyAmount, nonRetainedAmount, pendingBalance, refundableSurplus, amountPaid }`. 409 si la reserva está cancelada, el pasajero ya se dio de baja, es el último activo o es el titular; 404 si no pertenece a la reserva; `numberPassengers − 1` |

**Ciclo de vida del tour** ([tours.service.ts](src/modules/tours/tours.service.ts); regla 15 y regla 8 de `../CLAUDE.md`). Todo en transacciones que bloquean la fila del tour (`SELECT … FOR UPDATE`); los rechazos son `ConflictError` → 409:

| Método | Regla |
|---|---|
| `updateTour` | Con algún movimiento en `payments` del tour (`hasRegisteredPayments`), cambiar `currency` o `price` → 409 (`FROZEN_PRICING_ERROR`). Si cambia `depositPerPerson`, llama a `syncStatus` en cada reserva no cancelada ni borrada. Si el body trae `maxCapacity` o `staffCapacity`, la capacidad vendible resultante debe ser ≥ `BookingCapacityService.getOccupiedSeats` (si no, `ConflictError` → 409; decisión del PM, 2026-11-14) |
| `softDeleteTour` | 409 si hay reservas no canceladas o `SUM(amountPaid) ≠ 0` (reservas no borradas) |
| `assignVehicle` | Body `{ vehicleId }` o `{ templateId }` (exactamente uno, 400 si no). Con `templateId` usa `findOrCreateAgencyVehicle`. 404 si el vehículo, la plantilla o el tour no son válidos para la agencia. 409 si los asientos **de pasajero** del croquis (`getVehicleCapacity(...).passenger`) < `BookingCapacityService.getSeatRightSeats`. Luego pone `seatLabel = null` en los pasajeros del tour cuya etiqueta no exista en el layout y borra esos `tour_blocked_seats`. Devuelve el tour + `releasedSeats { passengers (solo ACTIVE), blocked }`. No toca `maxCapacity` |

**Schemas de tours:** `baseTourSchema` no tiene `.default()` (en Zod 4 se aplicaría también dentro de `.partial()` y un PATCH parcial reescribía moneda, anticipo y métodos de cobro). Los defaults viven solo en `createTourBodySchema`. `description` y `postPaymentInstructions` convierten `null` en `""` (la columna es `NOT NULL`); `destinationType` usa el enum `DESTINATION_TYPE`.

**`PaymentService`** ([payments.service.ts](src/modules/payments/payments.service.ts)):

- **Candado** (`lockBookingForUpdate`, 2026-11-15): ambos métodos bloquean la fila de la reserva antes de leer. Sin él, dos abonos simultáneos calculaban cada uno su `SUM` sin ver el otro (el último dejaba un `amountPaid` incompleto), dos reembolsos podían superar juntos el tope y un abono podía anularse dos veces. Reserva ajena → 404.
- **`registerPayment`:** antes de escribir, rechaza un `PAYMENT` en un tour cancelado (`ConflictError` → 409) un `REFUND` si la agencia no canceló el tour, salvo la excepción controlada de una reserva activa con `getRefundableSurplus` > 0 (2026-11-17), cuyo tope es exactamente ese saldo a favor (400 si se excede; con saldo $0 o reserva cancelada por el cliente → 409) y un `REFUND` mayor que el saldo a reembolsar (`summarizeRefunds`; `BusinessRuleError` → 400). Desde el 2026-11-17 también un `PAYMENT` en una reserva cancelada (409) y un `PAYMENT` mayor que el saldo pendiente (400, "El abono no puede superar el saldo pendiente de $X MXN.", con `formatMoney` de `shared/utils/money.util.ts`). Inserta el movimiento (negativo si es REFUND) y recalcula `amountPaid = SUM`. Luego deriva el estado:

  | Condición (`derivePaymentStatus`, única regla desde el 2026-11-17) | `paymentStatus` |
  |---|---|
  | `amountPaid ≤ 0` y hay una devolución real en el libro (`ledgerHasRefund`: REFUND que no es anulación) | REFUNDED |
  | `amountPaid ≤ 0` | PENDING |
  | `amountPaid ≥ total` | PAID |
  | en cualquier otro caso | PARTIAL |

  La usan también `voidPayment`, `applyFullCancellation`, `cancelPassenger`, `addPassengerToBooking` y `removePendingSlot` (estos cuatro pasan `hasRefund` = estado previo `REFUNDED`, porque no mueven dinero).

  También actualiza `lastPaymentMethod`.

- **`voidPayment`:** inserta un contra-asiento REFUND con `referenceInfo = "Anulación: … (Ref: id)"` y recalcula. Un abono ya anulado (existe un REFUND con su `(Ref: <id>)`) → 409 "Este abono ya fue anulado." (desde el 2026-11-15). Abono ajeno → 404; anular un REFUND → 409 (antes 400). Si la anulación dejaría lo pagado neto en negativo (ese dinero ya se devolvió con un reembolso) → 409 sin escribir (2026-11-17). En una reserva cancelada por el cliente (tour sin `cancelledAt`) también baja `totalPrice` (la retención) a lo realmente abonado. En un tour FINALIZADO o CANCELADO → 409 por el Modo Auditoría (OBS-004, 2026-11-17), así que la regla del neto negativo hoy solo es una defensa. `referenceInfo` ≤ 500 y el motivo ≤ 300 caracteres.
- Ambos métodos terminan con `BookingStatusService.syncStatus(tx, bookingId)`.

**Estado derivado** (decisión del PM, regla 11 de `../CLAUDE.md`): `BookingStatusService.syncStatus(tx, bookingId, { formCompleted? })` ([booking-status.service.ts](src/modules/bookings/booking-status.service.ts)) relee la reserva dentro de la transacción y aplica la función pura `calculateBookingStatus({ currentStatus, totalPaid, requiredDeposit, isFormComplete })`. El formulario se considera completo cuando la reserva ya salió de `AWAITING_REGISTRATION` (o cuando se pasa `formCompleted: true`, en el registro público). Se llama al final de `registerPayment`, `voidPayment`, `processGroupBooking`, `addPassengerToBooking`, `removePendingSlot` y `cancelPassenger`. **Cualquier flujo nuevo que cambie `amountPaid`, `totalPrice`, `numberPassengers` o el formulario debe llamarlo.**

**`MagicTokenService.validate`** ([magic-token.service.ts](src/modules/magic-tokens/magic-token.service.ts)):

- Calcula `flowState` en este orden:
  1. reserva CANCELLED → `CANCELLED`
  2. `AWAITING_REGISTRATION` → `PENDING_REGISTRATION`
  3. en otro caso, según `paymentStatus`: `PENDING_PAYMENT`, `PARTIAL_PAYMENT` o `PAID`
- Devuelve `{ isValid, flowState, meta: { agencyId, agency: { name, logoPath }, tourId, bookingId }, data }`. `meta.agency` va en **todos** los estados (incluido `CANCELLED`, cuyo `data` trae `tourInfo`, `cancellation { byAgency, reason, cancelledAt }` y `refund` de `summarizeRefunds` solo si canceló la agencia, `null` si canceló el cliente; nunca la nota interna) para que el front muestre la marca. En el estado de cuenta, `data` incluye `bookingStatus` y un `paymentHistory` **solo con abonos válidos**: excluye los REFUND y el abono que cada anulación referencia con `(Ref: <id>)`. Para el estado de cuenta PDF, el payload (PARTIAL_PAYMENT y PAID) trae `tourInfo.returnDate`, `tourInfo.policies`, `groupSize` (lugares apartados, `getExpectedGroupSize`), `phone` por pasajero (WhatsApp del viajero) y `data.agency` con: `name, phone, email, address, bankName, accountHolder, clabeNumber, cardNumber, policies, logoPath, primaryColor, secondaryColor, accentColor` (la consulta carga `tour.agency.branding`).
- `PENDING_REGISTRATION`: `prefillData.medicalNotes` va **vacío** desde el 2026-11-15 (dato sensible, LFPDPPP; mismo criterio que `lookup-traveler`). El registro solo completa campos vacíos, así que las notas que ya existían se conservan.
- La ruta asigna los códigos 404 (NOT_FOUND, también si el token no tiene reserva), 410 (EXPIRED, nunca se produce: el enlace no vence) y 409. Una excepción responde 500 con `code: "SERVER_ERROR"` (hasta el 2026-11-16 decía `NOT_FOUND` y el cliente leía que su enlace no existía); lo cubre `magic-link-portal.test.ts`.

**`DashboardService.getTourDashboard`** ([dashboard.service.ts](src/modules/dashboards/dashboard.service.ts)):

- Agrega las reservas no canceladas. Carga solo las columnas que muestra (sin notas médicas ni el hash de contraseña de quien registró el abono: `createdByUser: { columns: { fullName } }`).
- `equivalentMXN` suma `collectedAmount` con su signo (negativo en REFUND y anulaciones). Antes se restaba un monto ya negativo y un reembolso **aumentaba** el equivalente (corregido el 2026-11-15).
- **Tamaño del grupo** = `magicToken.numberPassengers`, o `round(total / precio)` como respaldo.
- **Métricas:**

  | Métrica | Cálculo |
  |---|---|
  | `occupancy.current` | Lugares ocupados (`BookingCapacityService`, regla 12) |
  | `occupancy.max` | Capacidad vendible (`maxCapacity − staffCapacity`) |
  | `revenue.projected` | capacidad vendible × `price` |
  | `revenue.collected` | Suma de `amountPaid` |
  | `logistics` | Solo grupos con derecho a asiento (`amountPaid ≥ requiredDeposit`) |

- Cada titular incluye `bookingStatus`, `requiredDeposit` (`depositPerPerson × tamaño del grupo`), `hasSeatRight`, `bookedAt` (`bookings.createdAt`), `retainedPenaltyTotal` (total − precio pactado × lugares apartados; se usan los lugares apartados porque los pendientes también se cobran) y `refundableSurplus` (abonado − total), ambos en 0 en una reserva cancelada (2026-11-17). El front usa `hasSeatRight` sin recalcular la regla. Si el grupo perdió el derecho a asiento, el asiento asignado **no se libera** (decisión del PM): el front solo lo señala. Con `bookedAt` el front muestra "Apartado hace N h sin pago" (regla 13).
- `formStatus` es PENDING si el viajero no tiene `emergencyContactPhone`.
- `requiresSeats = transportModality === TRANSPORT_INCLUDED`.
- `temporalStatus` = `getTourTemporalStatus` (PRÓXIMO, EN CURSO, FINALIZADO o CANCELADO), sin el cast a `ACTIVO` que tenía antes del 2026-11-14.
- `cancellation { cancelledAt, reason, note } | null` (la nota es interna) y `refunds[]`: reservas canceladas con dinero abonado de un tour **cancelado por la agencia** (segunda consulta, `status = CANCELLED`, solo si `tour.cancelledAt`; si canceló el cliente no hay devolución), cada una con `bookingId`, `travelerId`, `fullName`, `whatsapp`, `groupSize`, los montos de `summarizeRefunds` y `payments`. No cuentan para ocupación ni KPI.
- `returnDate` y `policies` del tour en la raíz (estado de cuenta PDF del operador).
- Titular y acompañantes traen `boardingPointDetails { location, time } | null`, resuelto con `findBoardingPoint` (la misma regla que el manifiesto y el Magic Link); el estado de cuenta PDF del operador lo usa para imprimir la hora de abordaje.
- `staffCapacity` del tour (tope de bloqueos de staff que usa el croquis), en la **raíz** de la respuesta: la ruta envía el objeto directo, sin envoltorio `data` (verificado el 2026-11-12 contra Neon: el tour "Zacatlán" responde `staffCapacity: 1`).
- `vehicle { id, templateId, name, layoutMap, capacity { total, passenger, staff } }` (o `null`).
- La forma de la respuesta la consume `tour-dashboard.schema.ts` del front.

## Archivos y almacenamiento

- Única implementación: [shared/storage/uploads.ts](src/shared/storage/uploads.ts) (carpetas, escritura por stream que borra el archivo parcial si falla, firma por magic bytes, borrado seguro con prefijo). Si se migra a almacenamiento en la nube (S3/R2), solo cambia ese módulo.
- **Rechazar una subida con el archivo ya en disco** (firma inválida, tamaño excedido): lanza `BusinessRuleError` en lugar de `reply.send`, para que el `finally` borre el archivo **antes** de responder. Con `send`, Fastify respondía primero y el archivo seguía en disco unos instantes; era la causa de las pruebas intermitentes de folleto y logotipo (corregido el 2026-11-16).
- `POST /tours/:tourId/brochure` acepta solo `application/pdf` con firma `%PDF-`, lo guarda en `public/uploads/brochures/tour-<id>-<ts>.pdf`, almacena `brochureUrl = "/uploads/brochures/…"` y borra el folleto anterior del mismo tour.
- La URL pública real es `http://<host>:3001/public/uploads/brochures/…`, **sin** `/api`.
- Logotipos: `POST /agencies/logo` (PNG/JPEG ≤ 2 MB) los guarda en `public/uploads/logos/agency-<agencyId>-<ts>.png|jpg` y almacena `agencies.logoPath = "/uploads/logos/…"`. El front los descarga desde otro origen para insertarlos en el PDF: `@fastify/cors` también cubre `/public` (probado en `agency-branding.test.ts`).
- `public/uploads/brochures/*` y `public/uploads/logos/*` están en `.gitignore` desde el 2026-11-15 (datos de clientes; antes quedaban versionados). `public/uploads/.DS_Store` se sacó del repo el 2026-11-16 (`.DS_Store` ya está en `.gitignore`).

## Integraciones externas

- Solo Neon Postgres. No hay correo, WhatsApp API, pasarela de pagos ni almacenamiento en la nube.
- WhatsApp y pagos son externos y se resuelven en el front con enlaces.

## Al modificar el backend

- **Respuestas públicas** (sin `authenticate`): devuelve solo proyecciones con lista blanca (`columns`) y nunca filas completas. Escribe la proyección explícita en la consulta o en el objeto de respuesta (el proyecto no usa constantes auxiliares para esto); para la agencia, solo `name`, `phone` y `logoPath` (el logotipo ya es un archivo público en `/public`). Los datos bancarios solo salen en rutas autenticadas de la propia agencia y en el magic link, que los necesita para el pago del cliente.
- Filtra siempre por `agencyId` de `request.user` y usa transacciones para cualquier cambio de dinero o cupo.
- **Enums del contrato:** el rol del pasajero se escribe con `PASSENGER_ROLE.TITULAR` / `.COMPANION` y se valida con `z.enum(PASSENGER_ROLES)` (`shared/constants/domain.constants.ts`; lo usan `booking.schema`, `booking.service` y `dashboard.service`). No escribas el texto a mano.
- **Errores de negocio:** lanza `NotFoundError` / `BusinessRuleError` / `ConflictError` / `CapacityExceededError` (`shared/errors/domain-errors.ts`) desde el servicio; el manejador global los traduce. No compares el texto del mensaje ni armes el 500 a mano.
- **Modo Auditoría:** toda mutación nueva del operador sobre un tour, sus reservas, sus pagos o sus asientos llama a `assertTourNotInAuditMode` dentro de su transacción, antes de escribir (pide al tour `departureDateTime`, `returnDate` y `cancelledAt`).
- **Dinero o grupo de una reserva:** empieza la transacción con `lockBookingForUpdate` (respeta el orden tour → reserva). Archivos: usa `shared/storage/uploads.ts` y valida la firma.
- **Columnas:** en consultas con relaciones (`with`), pide solo las columnas que usas (`columns: {…}`), sobre todo de `travelers` (notas médicas), `agencies` (datos bancarios) y `agency_users` (hash de contraseña).
- Si cambias la forma de una respuesta, un enum o una ruta, actualiza el hook o schema correspondiente en `tripagent-front` y la sección C de `../CLAUDE.md`.
- Revisa la sección G de `../CLAUDE.md` (deuda conocida) antes de tocar ocupación, `paymentStatus`, magic tokens o asientos.
- **Teléfonos:** valida con `phoneSchema` / `optionalPhoneSchema` + `phoneCountrySchema` y `refinePhoneCountry` en el `superRefine` del objeto (no escribas regex de 10 dígitos). Busca viajeros por WhatsApp con `phoneLookupCandidates` y compara con `isSamePhone`, nunca con `===`.
- Validación mínima: `npm test`, `npm run build` (tsc, 0 errores desde el 2026-11-15), `npx eslint .` (0 errores y 0 warnings) y `npm run format:check`.

## Aislamiento multi-tenant (estrategia)

- **Fuente única del tenant:** `request.user.agencyId` (JWT firmado). En rutas públicas, el tenant sale del recurso: el token del Magic Link (`magic_tokens.agencyId`) o el tour del folleto. Nunca del body ni de la query.
- **Toda lectura o escritura por id** filtra `agencyId` en el mismo `WHERE` (o valida la reserva/tour padre de la agencia antes de tocar hijos: pasajeros, pagos, asientos). Un recurso ajeno responde **404** (no 403), para no revelar que existe; excepción histórica: `GET /agencies/:id` → 403.
- **Ids del cliente no confiables:** `tourId` del body en `add-passenger` debe coincidir con el de la reserva; `passengerId` de asientos debe ser de una reserva activa del tour; `vehicleId`/`templateId` se resuelven contra la agencia.
- **Archivos:** las rutas se generan en el servidor (`tour-<id>-<ts>`, `agency-<id>-<ts>`), no son escribibles por body y solo se borran con prefijo del dueño.
- **Pruebas:** `rowMatches()` permite afirmar que una consulta filtra por `agencyId` (`tenant-ownership`, `tour-seats`, `architecture-audit`).

## Escalabilidad y base de datos

- **Índices** (migración `0031_performance_indexes`, aplicada en Neon el 2026-11-16): Postgres no indexa las FK automáticamente. Se agregaron `bookings(tour_id)`, `bookings(traveler_id)`, `booking_passengers(booking_id)`, `booking_passengers(traveler_id)`, `magic_tokens(booking_id)` (cada `with: { magicToken }` era un escaneo completo), `payments(booking_id, created_at)` (SUM del libro e historial), `tours(agency_id, created_at) WHERE deleted_at IS NULL` y `travelers(agency_id, created_at) WHERE deleted_at IS NULL` (listados paginados; índice ascendente recorrido hacia atrás = `ORDER BY created_at DESC`), `vehicles(agency_id)` y `agency_users(agency_id)`. Los índices únicos parciales existentes solo cubren filas no canceladas.
  - **Índices nuevos:** el migrador (`npm run db:migrate`, escribe en Neon) los crea con `CREATE INDEX` normales dentro de la transacción del migrador: bloquean escrituras en cada tabla mientras se construye el índice (milisegundos con el volumen actual). Con tablas de millones de filas, créalos antes a mano con `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` (fuera de una transacción) y después marca la migración.
- **Escenario A (MVP, hoy):** suficiente con los índices, el pool de 10 y una instancia. Sin caché ni colas: los PDF se generan en el cliente (jsPDF), no hay correo ni tareas largas en el servidor.
- **Escenario B (cientos de agencias):** varias instancias → límite de intentos en Redis (`@fastify/rate-limit` acepta `redis`), `DB_POOL_MAX` por instancia + pooler de Neon, folletos/logos en almacenamiento de objetos (solo cambia `shared/storage/uploads.ts`). `authenticate` hace una consulta por petición (`isSessionActive`, por PK): cachéala unos segundos si se vuelve un cuello de botella. La búsqueda `ILIKE '%…%'` de tours y viajeros no usa índices B-tree: `pg_trgm` + índice GIN cuando el CRM crezca.
- **Escenario C (miles de agencias, millones de reservas):** paginación por cursor (`created_at, id`) en lugar de `offset` en `/tours` y `/travelers`; mover el agregado de ocupación del listado de tours a SQL (`GROUP BY tour_id`) o a una columna mantenida; `payments` es solo inserción y será la tabla más grande: particionar por fecha o archivar movimientos de tours finalizados solo cuando supere decenas de millones de filas y las consultas lo justifiquen. Réplicas de lectura para reportes.
- **No se implementó** (sin necesidad demostrada): caché distribuida, colas, particionamiento, réplicas, paginación por cursor.

- **Fechas (2026-11-17):** `shared/utils/mexico-date.util.ts` (`getTodayInMexico`, `isFutureDate`, `isPastDate` y los mensajes). Fecha de nacimiento obligatoria y no futura en `POST /bookings/public/register` (titular y acompañantes; antes `emptyToUndefined`) y no futura en `/travelers`. Pruebas: `test/date-rules.test.ts`.
