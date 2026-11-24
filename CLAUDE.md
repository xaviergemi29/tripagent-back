# tripagent-api — Reglas y patrones del backend

> Contexto global (producto, contrato front-back, reglas de negocio numeradas, deuda) en `../CLAUDE.md`. Repo Git independiente: no hagas commit, push ni pull sin que el usuario lo pida.
> Este archivo contiene **solo reglas vigentes**. El historial (qué se corrigió, cuándo y por qué, y la cobertura de pruebas detallada) está en `docs/historial-claude-api.md` y en `../reporte-mvp.md`: consúltalos solo si necesitas el motivo de una regla.

## Stack

Node + TypeScript ^5.7 ESM (`NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) · Fastify 5 · fastify-type-provider-zod + Zod 4 · Drizzle ORM 0.45 / drizzle-kit 0.31 · postgres.js hacia Neon (`ssl: "require"`) · @fastify/jwt + cookie, cors, multipart, static, rate-limit (en memoria) · bcryptjs (costo 12) · tsx · `libphonenumber-js` 1.13.15 exacta (misma que el front).

No agregues dependencias sin justificarlo; fija versiones con al menos dos semanas de antigüedad.

## Scripts y entorno

```
npm run dev | build (tsc) | start | test (node:test + tsx) | format / format:check
npx eslint .                    # no hay script de lint
npx drizzle-kit check           # valida migraciones sin conexión
npm run db:generate             # SQL en ./drizzle desde schema.ts
npm run db:migrate              # escribe en Neon: solo con autorización (nunca db:push)
npm run tenant:create -- --name= --email= --adminPassword= [--phone= --phoneCountry=MX --adminName=]
npm run vehicle-templates:sync  # escribe en Neon
npm run phones:normalize        # solo reporta; con -- --apply escribe en Neon
```

Validación mínima tras cualquier cambio: `npm test`, `npm run build`, `npx eslint .` y `npm run format:check`, todos sin errores **ni warnings**.

Variables (`.env`, plantilla `.env.example`): `DATABASE_URL` (obligatoria), `PORT` (3001), `DB_POOL_MAX` (10, por instancia), `JWT_SECRET` y `COOKIE_SECRET` (obligatorias, ≥ 32 y distintas; si no, `SecurityConfigError`), `CORS_ORIGINS` (obligatoria en producción), `TRUST_PROXY`, `INTERNAL_PROXY_SECRET` (IP del visitante desde el servidor de Next), `SUBSCRIPTION_*` (canales de pago de TripAgent; si faltan → `null`), `NODE_ENV=production` (cookie `Secure` + HSTS).

## Estructura

```
src/
├── app.ts            # buildApp(): plugins, authenticate, CORS, errores, módulos
├── server.ts         # arranque + apagado ordenado
├── db/               # index.ts (db), schema.ts ★ (tablas, enums, relaciones), migrate.ts, CLIs, catalog/vehicle-templates.catalog.ts
├── shared/
│   ├── constants/domain.constants.ts   # enums del contrato que NO son de BD (PASSENGER_ROLE, TOUR_TEMPORAL_STATUS, CONFLICT_CODES…)
│   ├── errors/domain-errors.ts         # NotFoundError 404, BusinessRuleError 400, ConflictError / CapacityExceededError 409
│   ├── schemas/                        # policies.schema.ts, phone.schema.ts
│   ├── security/                       # security.config, rate-limits (RATE_LIMITS), client-ip, error-message (GENERIC_ERROR_MESSAGE)
│   ├── storage/uploads.ts              # ★ única implementación de archivos
│   └── utils/                          # reglas puras (ver "Utilidades obligatorias")
└── modules/<dominio>/{<dominio>.routes.ts, .schema.ts, .service.ts}   # bookings usa singular (booking.*)
drizzle/              # migraciones 0000…0043 (todas aplicadas en Neon); meta/ generado, no editar
public/uploads/{brochures,logos}/   # archivos subidos (en .gitignore)
test/                 # fuera de src/ (tsc no las compila)
```

## Arquitectura

- **Capas:** route → service (clase con métodos estáticos) → `db`. Sin repositorios, controladores en clase ni inyección de dependencias (decisión vigente: no introducir Clean/Hexagonal/DDD sin un problema real).
- **Petición:** `onRequest` (`app.authenticate`) → validación Zod (`schema: { params, querystring, body }`, 400 automático con `issues`) → `preHandler` (rate limit con body) → handler → servicio → respuesta. No se usan schemas de `response`.
- **Rutas sin `try/catch`:** el `app.setErrorHandler` traduce los errores de dominio a `{ error }` (y `code` / `availableSeats` si existen) y convierte cualquier otro error en 500 con `GENERIC_ERROR_MESSAGE` (falla cerrado: nunca SQL ni el texto interno). Solo se atrapa lo propio de la ruta (`23505`/`23503` → 409, `FST_REQ_FILE_TOO_LARGE` → 400) y se relanza el resto. Excepción: `GET /magic-tokens/:token/validate` responde su propio formato `{ isValid, error: { code } }`.
- **Errores:** el servicio lanza el error tipado con mensaje en español. `throw new Error()` = fallo interno (500). **Nunca** compares el texto de un mensaje para decidir el código; los 409 que el cliente distingue llevan `code` de `CONFLICT_CODES`.
- **Respuestas** (no uniformes; el front desenvuelve `.data`): `{ data }`, `{ success, data }`, `{ data, pagination }` u objeto directo. Si cambias una forma, revisa el interceptor del front (sección C de `../CLAUDE.md`).
- **Imports** relativos con extensión `.js`. Prettier 100 columnas, comillas dobles. Comentarios y mensajes en español.

## Autenticación y seguridad

- `app.authenticate`: JWT de la cookie `token` (1 día) → 401; usuario activo de la agencia del token y agencia activa sin `deletedAt` (`isSessionActive`) → 401 `INACTIVE_USER_MESSAGE`; mutación (no GET/HEAD/OPTIONS) con la agencia en Modo Solo Lectura (`isAgencyReadOnly`) → **402** `SUBSCRIPTION_READ_ONLY`, salvo `READ_ONLY_ALLOWED_ROUTES` en `app.ts` (cambio de contraseña y marcar notificaciones). Una ruta nueva que escribe hereda el candado si usa `authenticate`.
- `request.user = { id, agencyId, role }`. El `agencyId` sale **solo** de aquí. Los roles no se comprueban (deuda aceptada, G de `../CLAUDE.md`).
- **Rutas públicas:** declaran `config: { rateLimit: RATE_LIMITS.<x> }` (las de lectura armadas en Next usan `getClientIp`), devuelven proyecciones con lista blanca (agencia: solo `name`, `phone`, `logoPath`, `address`; nunca datos bancarios salvo el Magic Link) y, si escriben en nombre de una agencia, revisan `isAgencyReadOnly` en el servicio (como la pre-reserva).
- Login: correo `trim().toLowerCase()` antes de validar; correo inexistente compara contra un hash de relleno (mismo tiempo y mensaje "Credenciales inválidas").
- Hook `onSend`: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS en producción. CORS con `resolveCorsOrigin()` y credenciales. El logger oculta tokens y `?phone=` (`redactSensitiveUrl`).
- `buildApp({ isSessionActive, isAgencyReadOnly })` permite sustituir ambas verificaciones en pruebas.

## Multi-tenant

- Toda lectura o escritura por id filtra `agencyId` en el mismo `WHERE` (o valida el padre de la agencia antes de tocar hijos). Recurso ajeno → **404**, nunca 403.
- En rutas públicas el tenant sale del recurso (magic token, tour del folleto, token de staff), nunca del body ni de la query.
- Ids del cliente no confiables: `tourId` del body debe coincidir con el de la reserva; `passengerId` debe ser de una reserva activa del tour; `vehicleId`/`templateId` se resuelven contra la agencia.

## Base de datos y consultas

- Lecturas con relaciones: `db.query.<t>.findFirst/findMany({ where, with, columns })` con **lista blanca de columnas**, sobre todo en `travelers` (datos personales), `agencies` (bancarios) y `agency_users` (hash). Escrituras y agregados: query builder; métricas con `sql\`\``. Sin N+1 (usa JOIN, `inArray` o agregados SQL).
- `numeric(..., mode: "number")` → `Number(...)` antes de operar; sumas en SQL con `COALESCE(SUM(...), 0)`.
- Timestamps `mode: "string"`; asigna `updatedAt: new Date().toISOString()` en cada update (no hay trigger).
- Borrado lógico (`deletedAt`) en tours, viajeros y reservas; las lecturas filtran `isNull(x.deletedAt)`. No hay borrados físicos.
- **Schemas Zod:** sin `.default()` en un schema base que se reutilice con `.partial()` para PATCH; los defaults solo en `createTourBodySchema`. `brochureUrl` y `logoPath` no son escribibles por body.
- Cambiar el esquema: edita `schema.ts` → `npm run db:generate` → revisa el SQL → `db:migrate` solo con autorización. `phone_normalization_backup` vive fuera de Drizzle (nunca `db:push`). Con tablas grandes, crea índices a mano con `CREATE INDEX CONCURRENTLY`.

## Transacciones y concurrencia

- Dinero, cupo, asientos o varias tablas → `db.transaction(async (tx) => …)` usando `tx` en todo.
- Candados `FOR UPDATE` en **orden fijo tour → reserva**: tour con `BookingCapacityService.assertSeatsAvailable` (o el bloqueo del servicio de tours/asientos); reserva con `lockBookingForUpdate(tx, bookingId, agencyId)` (`modules/bookings/booking-lock.util.ts`, también valida pertenencia → 404).
- Toda mutación de dinero o grupo de una reserva empieza con `lockBookingForUpdate`. Todo flujo que **aumente** lugares llama a `assertSeatsAvailable` dentro de su transacción.
- Todo flujo que cambie `amountPaid`, `totalPrice`, `numberPassengers` o el formulario termina con `BookingStatusService.syncStatus(tx, bookingId)`.
- Toda mutación del operador sobre un tour, sus reservas, pagos o asientos llama a `assertTourNotInAuditMode(tour)` antes de escribir (necesita `departureDateTime`, `returnDate`, `cancelledAt`). Excepciones en la regla 9 de `../CLAUDE.md`.
- Los avisos in-app se insertan con la `tx` del flujo (`NotificationService.create(tx, …)`), solo desde acciones públicas del viajero.

## Utilidades obligatorias (única fuente de verdad)

- **Reglas de reserva** (`shared/utils/booking-rules.util.ts`): tamaño de grupo (`getExpectedGroupSize`), anticipo requerido, `isDepositCovered`, `calculateBookingStatus`, `getSellableCapacity`, `resolveAgreedUnitPrice` (precio pactado), `summarizeCompanionDrop`, `getRetainedPenaltyTotal`, `getRefundableSurplus`, `getBookingFormStatus` (`formStatus` del dashboard: de la reserva, nunca de los datos del viajero).
- **Cupo:** `BookingCapacityService` (`getOccupiedSeats`, `assertSeatsAvailable`, `getSeatRightSeats`).
- **Pago:** `derivePaymentStatus` (`payment-status.util.ts`). **Reembolsos:** `summarizeRefunds`, `isVoidEntry` (`refund.util.ts`). Montos en mensajes: `formatMoney` (`money.util.ts`).
- **Tour:** `getTourTemporalStatus` / `getTourLastActiveDate` (`tour-status.util.ts`), `assertTourNotInAuditMode` (`tour-audit-mode.util.ts`). Fechas de negocio en CDMX: `mexico-date.util.ts` (`getTodayInMexico`, `isFutureDate`, `isPastDate`).
- **Teléfonos:** `phoneSchema` / `optionalPhoneSchema` + `phoneCountrySchema` + `refinePhoneCountry` en el `superRefine`; buscar con `phoneLookupCandidates`, comparar con `isSamePhone` (nunca `===` ni regex de 10 dígitos). Viajeros existentes en el registro: `fillEmptyTravelerFields`; lada anterior: `confirmLegacyPhone`.
- **Croquis:** `layoutMapSchema`, `getLayoutSeats`, `getLayoutSeatLabels`, `getVehicleCapacity` (`vehicle-layout.util.ts`). Abordaje: `findBoardingPoint` (`boarding-point.util.ts`).
- **Suscripción:** `isSubscriptionReadOnly` (`subscription.util.ts`); consulta del candado: `AgencySubscriptionService.isReadOnly`.
- **Hospedaje:** capacidad por tipo de habitación solo de `LODGING_ROOM_CAPACITY` (`domain.constants.ts`), nunca del body; `position` con `planRoomBatch` (`lodging.service.ts`). "Pasajero vigente" = `activePassengerWhere` (única definición): las asignaciones de los demás no cuentan. Toda mutación pasa por `lockLodgingTour` (FOR UPDATE + Modo Auditoría). Validaciones de cama con `room.capacity`. Eliminar una cama cambia `roomType` al de la nueva capacidad con `resolveRoomTypeForCapacity` (`shared/utils/lodging-room.util.ts`; 1 → SINGLE, 2 → DOUBLE_INDIVIDUAL, 3 → TRIPLE). `SINGLE` va al final de `LODGING_ROOM_TYPES` (el orden del enum de BD). Pruebas con la base en memoria `test/fake-lodging-db.ts` (evalúa JOIN, `=`, `<>`, `is null`, `in` y `orderBy` del SQL real; aplica los índices únicos fila por fila y el cascade habitación → asignaciones).
- **Enlace de staff:** `staff-share.util.ts` (token, vigencia, `describeStaffShare`, mensaje 404 único).
- **Archivos:** `shared/storage/uploads.ts` (`writeUpload`, `hasFileSignature` por magic bytes, `removeUpload` con prefijo del dueño). Nombres generados en el servidor (`tour-<id>-<ts>`, `agency-<id>-<ts>`). Rechazar una subida con el archivo en disco = lanzar `BusinessRuleError` (el `finally` borra antes de responder), nunca `reply.send`. URL pública: `<host>/public/uploads/…` (sin `/api`).
- **Enums del contrato:** desde `domain.constants.ts` (`PASSENGER_ROLE.TITULAR`, `z.enum(PASSENGER_ROLES)`…); nunca el texto a mano.

## Módulos (todos bajo `/api`)

`auth` (login, register-agency, me, logout, change-password) · `agencies` (perfil, subscription, subscription/cancel y /reactivate (solo `ADMIN`; regla 20), bank-account, policies, branding, logo) · `tours` (CRUD, brochure, vehicle, cancel, staff-share) · `tours-public` (`/tour-brochure/public/tours/:id`) · `bookings` (`/public/pre-booking`, `/bookings/public/register`, quick-booking, add-passenger, pending-slots, cancel-full, transfer) · `booking-passengers` (baja de acompañante) · `payments` (abono/reembolso, void) · `dashboards` (BFF del Centro de Control, objeto directo) · `tour-manifest` · `tour-seats` · `vehicles` (solo lectura) · `vehicle-templates` · `travelers` (listado, PATCH, DELETE = anonimizar, history) · `notifications` · `magic-tokens` (validate, lookup-traveler) · `staff-share` (`/public/staff-share/:token`, y su pase de lista `…/boarding`) · `boarding` (pase de lista del panel bajo `/tours`; `BoardingService` es la única lista de abordaje y la única marca, usada también por el enlace; regla 26) · `lodging` (hospedaje y rooming list: `GET /lodging/:tourId`, `POST /lodging/:tourId/rooms`, `PATCH /lodging/:tourId/rooms/:roomId`, `POST …/rooms/:roomId/assignments`, `DELETE …/rooms/:roomId/slots/:slotIndex`, `DELETE …/rooms/:roomId`, `DELETE …/rooms/:roomId/beds/:slotIndex`; regla 27).

Contratos de cada endpoint: sección C de `../CLAUDE.md`. Reglas de negocio: sección D. Para el detalle de un flujo, lee el servicio (`booking.service.ts`, `payments.service.ts`, `tours.service.ts`, `magic-token.service.ts`, `dashboard.service.ts`).

**Magic Link (`MagicTokenService.validate`):** el grupo (titular, acompañantes, `passengers`, `hasMinors`, prefill del registro) se arma solo con pasajeros `ACTIVE`; el `depositAmount` de `PENDING_PAYMENT` es `getRequiredDeposit(depositPerPerson, getExpectedGroupSize(...))` (lugares apartados, regla 8), nunca × filas de pasajeros.

## Pruebas

- `test/setup.ts` fuerza una `DATABASE_URL` inalcanzable: **ninguna prueba toca Neon**; toda consulta se simula.
- Rutas reales con `buildApp()` / `createTestApp()` + `app.inject()`; sesión con `sessionCookie()`; servicios o `db.query.*` con `mock.method`. `rowMatches()` (`test/helpers.ts`) evalúa un `where` de Drizzle para afirmar el filtro por `agencyId`; `chain(result)` simula un query builder. Flujos financieros de punta a punta con la base en memoria `test/fake-ledger-db.ts`.
- Los archivos corren en paralelo: una prueba que escriba en `public/uploads/` usa prefijos propios (otro tour u otra agencia).
- Todo cambio de regla o endpoint lleva su prueba en el archivo del dominio (`test/<dominio>.test.ts`).

## Al modificar el backend

- Si cambias una respuesta, un enum o una ruta: actualiza el schema/hook del front y la sección C de `../CLAUDE.md`. Los schemas Zod están duplicados en ambos repos (tabla en C).
- Revisa la sección G de `../CLAUDE.md` antes de tocar ocupación, `paymentStatus`, magic tokens o asientos.
- Documentación: aquí solo la regla o el patrón vigente, en pocas líneas (sin "corregido el…", "antes…" ni conteos de pruebas). El historial va a `../reporte-mvp.md`.
