import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  date,
} from "drizzle-orm/pg-core";
import type { LayoutMap } from "../shared/utils/vehicle-layout.util.js";

export const CURRENCIES = pgEnum("currency", ["MXN", "USD"]);
export const DESTINATION_TYPE = pgEnum("destination_type", ["NATIONAL", "INTERNATIONAL"]);

// Control del ciclo de vida del pasajero individual (Cancelaciones Parciales)
export const PASSENGER_STATUS = pgEnum("passenger_status", ["ACTIVE", "CANCELLED"]);

// Vías por las que entra/sale dinero
export const PAYMENT_METHOD = pgEnum("payment_method", ["CASH", "TRANSFER", "CARD", "OTHER"]);

// Naturaleza del movimiento financiero
export const PAYMENT_TYPE = pgEnum("payment_type", [
  "PAYMENT", // Entrada de dinero
  "REFUND", // Salida de dinero (Reembolso)
]);

export const TOUR_MODALITIES = pgEnum("transport_modality", [
  "TRANSPORT_INCLUDED",
  "INDEPENDENT_ACCESS",
]);

// ✅ NUEVO: Enum para el estado de la suscripción (Estándar SaaS)
export const SUBSCRIPTION_STATUS = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

// ✅ 1. NUEVOS ENUMS PARA MAYOR CONTROL
export const BOOKING_STATUS = pgEnum("booking_status", [
  "AWAITING_REGISTRATION",
  "PENDING", // Reservó pero falta confirmación
  "CONFIRMED", // Lugar asegurado en el bus
  "CANCELLED", // Cancelación por parte del cliente o agencia
  "NO_SHOW", // No llegó al punto de encuentro
]);

export const PAYMENT_STATUS = pgEnum("payment_status", [
  "PENDING", // 0 pagos
  "PARTIAL", // Dio un anticipo
  "PAID", // Liquidado al 100%
  "REFUNDED", // Se canceló y se le devolvió el dinero
]);

//  Nuevo Enum para el modelo de negocio (Tarifas y Auditoría)
export const PASSENGER_TYPE = pgEnum("passenger_type", ["ADULT", "CHILD"]);

export const AGENCY_ROLES = pgEnum("agency_roles", ["ADMIN", "SALES", "GUIDE"]);

export type CustomFields = Record<string, unknown>;

// ============================================================================
// 1. AGENCIES (El núcleo Multi-Tenant)
// ============================================================r================
export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  // WhatsApp oficial en E.164 (+522281234567). Registros anteriores pueden tener 10 dígitos hasta
  // correr `npm run phones:normalize` (shared/utils/phone.util.ts).
  phone: varchar("phone", { length: 20 }),
  // País del teléfono (ISO 3166-1 alfa-2: MX, US, CA…). Nulo = lada inferida, sin confirmar.
  phoneCountry: varchar("phone_country", { length: 2 }),
  // Ruta del archivo físico del logotipo (PNG/JPEG) dentro de public/, p. ej.
  // "/uploads/logos/agency-<id>-<ts>.png". Se sirve en <origen API>/public/… (sin /api).
  // Se sube desde Configuración (POST /agencies/logo); no es una URL externa.
  logoPath: text("logo_path"),
  // Enlace al aviso de privacidad de la agencia (LFPDPPP). El viajero lo acepta con una casilla
  // obligatoria al registrarse en el Magic Link (decisión del PM, 2026-11-14). Nulo = sin enlace.
  privacyNoticeUrl: text("privacy_notice_url"),
  // Políticas generales de la agencia (cancelación, pagos, conducta…), texto libre ≤ 5000.
  // Se imprimen en el estado de cuenta PDF junto con las del tour. Se editan en Configuración.
  policies: text("policies"),
  email: varchar("email", { length: 255 }).notNull(),
  // Control de Suscripción
  subscriptionStatus: SUBSCRIPTION_STATUS("subscription_status").default("trialing").notNull(),
  trialEndsAt: timestamp("trial_ends_at", { mode: "string", withTimezone: true }),
  bankName: varchar("bank_name", { length: 100 }),
  bankAccountHolder: varchar("bank_account_holder", { length: 255 }),
  clabeNumber: varchar("clabe_number", { length: 18 }),
  address: text("address"), // Usamos text para direcciones largas
  cardNumber: varchar("card_number", { length: 16 }), // 16 dígitos estándar
  isActive: boolean("is_active").default(true).notNull(),
  // Timestamps y Soft Delete
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }), // ✅ Soft Delete
});

/**
 * Identidad visual de la agencia (1:1 con `agencies`): colores de marca que usan los
 * comprobantes PDF. Solo guarda colores; el logotipo vive en `agencies.logoPath`.
 * Una agencia sin fila usa los colores por defecto (`DEFAULT_BRANDING_COLORS`); la fila se
 * crea con upsert al guardar por primera vez.
 */
export const agencyBranding = pgTable("agency_branding", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .references(() => agencies.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  primaryColor: varchar("primary_color", { length: 7 }).default("#4f46e5").notNull(),
  secondaryColor: varchar("secondary_color", { length: 7 }).default("#4338ca").notNull(),
  accentColor: varchar("accent_color", { length: 7 }),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 2 AGENCY USERS (Operadores, Guías y Agentes de IA)
// ============================================================================
export const agencyUsers = pgTable(
  "agency_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    role: AGENCY_ROLES("role").default("SALES").notNull(),
    // Soft-delete operativo (evita romper historial si se despide a alguien)
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // Usuarios de una agencia (alta por CLI, futura administración de roles).
  (table) => [index("idx_agency_users_agency").on(table.agencyId)],
);

// ============================================================================
// 3. TRAVELERS
// ============================================================================
export const travelers = pgTable(
  "travelers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),

    fullName: varchar("full_name", { length: 255 }).notNull(),
    // Teléfonos en E.164 (+522281234567) + país ISO alfa-2 (distingue +1 EE. UU. / Canadá).
    // País nulo = lada inferida y sin confirmar (registros anteriores al selector de lada).
    whatsappPhone: varchar("whatsapp_phone", { length: 20 }),
    whatsappCountry: varchar("whatsapp_country", { length: 2 }),
    email: varchar("email", { length: 255 }),

    emergencyContactName: varchar("emergency_contact_name", { length: 255 }).notNull(),
    // "" mientras el viajero no llena su formulario (el dashboard lo usa como "pendiente").
    emergencyContactPhone: varchar("emergency_contact_phone", { length: 20 }).notNull(),
    emergencyContactCountry: varchar("emergency_contact_country", { length: 2 }),
    // Sin notas médicas (2026-11-22, PM): el estado de salud es dato sensible (LFPDPPP art. 2-VI)
    // y exige consentimiento expreso y por escrito (art. 8). La columna se eliminó (0036).
    birthDate: date("birth_date"),

    customFields: jsonb("custom_fields").$type<CustomFields>().default({}),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),

    deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    // ✅ NUEVO: Índice Único Parcial por Agencia + WhatsApp
    // Esto evita duplicados del mismo titular, pero permite múltiples acompañantes con teléfono NULL
    uniqueIndex("idx_unique_agency_whatsapp")
      .on(table.agencyId, table.whatsappPhone)
      .where(sql`${table.whatsappPhone} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    // CRM: listado paginado por agencia, más recientes primero (GET /travelers).
    index("idx_travelers_agency_created")
      .on(table.agencyId, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// ============================================================================
// 4. TOURS
// ============================================================================
export const tours = pgTable(
  "tours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => agencyUsers.id, {
      onDelete: "set null",
    }),
    updatedByUserId: uuid("updated_by_user_id").references(() => agencyUsers.id, {
      onDelete: "set null",
    }),
    destinationType: DESTINATION_TYPE("destination_type").default("NATIONAL").notNull(),
    title: varchar("title", { length: 100 }).notNull(),
    description: text("description").default("").notNull(),
    transportModality: TOUR_MODALITIES("transport_modality")
      .default("TRANSPORT_INCLUDED")
      .notNull(),
    price: numeric("price", { precision: 10, scale: 2, mode: "number" }).notNull(),
    currency: CURRENCIES("currency").default("MXN").notNull(),
    depositPerPerson: numeric("deposit_per_person", { precision: 10, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    departureDateTime: date("departure_date_time", { mode: "string" }).notNull(),
    returnDate: date("return_date", { mode: "string" }),
    maxCapacity: integer("max_capacity").notNull(),
    // Lugares operativos (chofer, guía) que nunca se venden. Capacidad vendible = max - staff.
    staffCapacity: integer("staff_capacity").default(0).notNull(),

    // Cancelación por la agencia (decisión del PM, 2026-11-14): evento definitivo de fuerza mayor que
    // cancela todas las reservas y obliga a reembolsar lo abonado. Nulo = el tour no está cancelado.
    cancelledAt: timestamp("cancelled_at", { mode: "string", withTimezone: true }),
    // Código de TOUR_CANCELLATION_REASONS (WEATHER, SECURITY, LOW_SALES, OTHER).
    cancellationReason: varchar("cancellation_reason", { length: 32 }),
    // Nota interna opcional del operador (≤ 200 caracteres). No se muestra al viajero.
    cancellationNote: varchar("cancellation_note", { length: 200 }),

    // Configuración de cobro
    acceptsBankTransfer: boolean("accepts_bank_transfer").default(false).notNull(),
    acceptsCreditCard: boolean("accepts_credit_card").default(false).notNull(),
    postPaymentInstructions: text("post_payment_instructions").default("").notNull(),
    // Sin políticas propias: solo existen las de la agencia (regla 17). La columna `policies` se
    // eliminó en la migración 0029 (2026-11-14).

    acceptsCash: boolean("accepts_cash").default(false).notNull(),
    cashInstructions: text("cash_instructions"),
    boardingPoints: jsonb("boarding_points")
      .$type<{ id: string; time: string; location: string }[]>()
      .default([])
      .notNull(),
    brochureUrl: text("brochure_url"),
    // Enlace de staff (regla 26, 2026-11-22): token del enlace público de solo lectura del croquis y
    // la lista de pasajeros para el coordinador, sin cuenta. Nulo = enlace desactivado. Regenerarlo
    // invalida el anterior. La vigencia se calcula (`getStaffShareExpiresAt`), no se guarda.
    staffShareToken: text("staff_share_token"),
    // Último operador que creó o regeneró el enlace (auditoría por operador, sección G).
    staffShareTokenCreatedByUserId: uuid("staff_share_token_created_by_user_id").references(
      () => agencyUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    // Listado de tours de la agencia, más recientes primero (GET /tours).
    index("idx_tours_agency_created")
      .on(table.agencyId, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),
    // Búsqueda del enlace de staff por token (ruta pública) y unicidad del token.
    uniqueIndex("idx_tours_staff_share_token").on(table.staffShareToken),
  ],
);

// ============================================================================
// 5. BOOKINGS
// ============================================================================
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    tourId: uuid("tour_id")
      .references(() => tours.id, { onDelete: "cascade" })
      .notNull(),
    travelerId: uuid("traveler_id")
      .references(() => travelers.id, { onDelete: "cascade" })
      .notNull(),

    // AGRUPACIÓN DE VIAJEROS:
    // Todos los miembros de una familia/grupo comparten este mismo string (Ej. "GRP-A8F2")
    groupReference: varchar("group_reference", { length: 100 }),

    status: BOOKING_STATUS("booking_status").default("PENDING").notNull(),
    paymentStatus: PAYMENT_STATUS("payment_status").default("PENDING").notNull(),

    // Guardamos el precio en el momento de la reserva por si el Tour cambia de precio después
    currency: CURRENCIES("currency").default("MXN").notNull(),
    totalPrice: numeric("total_price", { precision: 10, scale: 2, mode: "number" }).notNull(),
    // Precio pactado por lugar (precio del tour al apartar; 2026-11-17). Las altas, bajas y lugares
    // liberados usan este precio, nunca el total ya ajustado ni el precio actual del tour. Nulo en
    // reservas anteriores a la columna que la migración no pudo calcular: se usa total ÷ lugares.
    unitPrice: numeric("unit_price", { precision: 10, scale: 2, mode: "number" }),
    amountPaid: numeric("amount_paid", { precision: 10, scale: 2, mode: "number" })
      .default(0)
      .notNull(),

    // Vía de pago del anticipo/total (Cash, Transfer, Card)
    lastPaymentMethod: PAYMENT_METHOD("last_payment_method"),

    // Fecha y hora en que el titular aceptó el aviso de privacidad al registrar al grupo en el
    // Magic Link (datos sensibles: notas médicas). Nulo = registro anterior a la casilla.
    privacyNoticeAcceptedAt: timestamp("privacy_notice_accepted_at", {
      mode: "string",
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    // 🛡️ Blindaje Anti-Duplicados: Solo permite UNA reserva activa (no cancelada) por tour y viajero
    uniqueIndex("idx_unique_active_tour_traveler")
      .on(table.tourId, table.travelerId)
      .where(sql`${table.status} <> 'CANCELLED'`),
    // Todas las reservas de un tour, incluidas las canceladas (cupo, dashboard, reembolsos,
    // asientos, manifiesto, borrado protegido). El índice parcial de arriba no cubre las canceladas.
    index("idx_bookings_tour").on(table.tourId),
    // Historial CRM y reservas de un titular.
    index("idx_bookings_traveler").on(table.travelerId),
  ],
);

// ============================================================================
// 6. BOOKINGS PASSENGERS
// ============================================================================
export const bookingPassengers = pgTable(
  "booking_passengers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Llaves foráneas con borrado en cascada
    bookingId: uuid("booking_id")
      .references(() => bookings.id, { onDelete: "cascade" })
      .notNull(),

    travelerId: uuid("traveler_id")
      .references(() => travelers.id, { onDelete: "cascade" })
      .notNull(),
    seatAssignedByUserId: uuid("seat_assigned_by_user_id").references(() => agencyUsers.id, {
      onDelete: "set null",
    }),
    // Regla de Negocio: Saber quién es el dueño financiero de este grupo
    isTitular: boolean("is_titular").default(false).notNull(),

    // Identificador comercial para auditoría de ingresos y manifiesto
    passengerType: PASSENGER_TYPE("passenger_type").default("ADULT").notNull(),

    boardingPoint: varchar("boarding_point", { length: 255 }),

    // Permite "bajar" a un pasajero sin borrar la historia
    status: PASSENGER_STATUS("status").default("ACTIVE").notNull(),
    seatLabel: varchar("seat_label", { length: 10 }),
    seatAssignedAt: timestamp("seat_assigned_at", { mode: "string", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // 🛡️ ÚNICO ACTIVO: Bloquea duplicados SOLO si el estatus es ACTIVE.
    // Si está CANCELLED, el índice lo ignora, permitiendo que la persona regrese después.
    uniqueIndex("idx_unique_active_booking_traveler")
      .on(table.bookingId, table.travelerId)
      .where(sql`${table.status} <> 'CANCELLED'`),
    // Pasajeros de una reserva, incluidos los cancelados (relación `passengers`, asientos).
    index("idx_booking_passengers_booking").on(table.bookingId),
    // Viajes de un viajero (historial CRM, subconsultas del listado, anti-duplicado por tour).
    index("idx_booking_passengers_traveler").on(table.travelerId),
  ],
);

// ============================================================================
// 7. MAGIC TOKENS
// ============================================================================
export const magicTokens = pgTable(
  "magic_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    tourId: uuid("tour_id")
      .references(() => tours.id, { onDelete: "cascade" })
      .notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => agencyUsers.id, {
      onDelete: "set null",
    }),

    // El Token criptográfico puro (ej. uuid sin guiones o nanoid)
    token: varchar("token", { length: 255 }).notNull().unique(),

    // Control de Cupos
    numberPassengers: integer("number_passengers").notNull(),
    currentUses: integer("current_uses").default(0).notNull(),

    // Decisión del PM (2026-11-11): el Magic Link NO vence (es el boleto digital y el estado de
    // cuenta del cliente). La columna se conserva por compatibilidad, pero no se valida en ningún flujo.
    expiresAt: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Relación reserva → token: la usan el cupo, el dashboard, el listado de tours y cada cambio de
    // grupo (`with: { magicToken }`). Sin índice era un escaneo de toda la tabla por reserva.
    index("idx_magic_tokens_booking").on(table.bookingId),
  ],
);

// ============================================================================
// 8. PAYMENTS (Libro Mayor de Transacciones)
// ============================================================================
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    bookingId: uuid("booking_id")
      .references(() => bookings.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => agencyUsers.id, {
      onDelete: "set null",
    }),
    // Clasificación de la transacción
    type: PAYMENT_TYPE("type").default("PAYMENT").notNull(),
    method: PAYMENT_METHOD("method").notNull(),

    // Monto exacto del movimiento. Reembolsos se guardarán como números negativos (-500)
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" }).notNull(),
    currency: CURRENCIES("currency").default("MXN").notNull(),

    collectedAmount: numeric("collected_amount", { precision: 10, scale: 2, mode: "number" }),
    collectedCurrency: CURRENCIES("collected_currency"),
    // Scale 4 es mandatorio para tipos de cambio bancarios en Fintech
    exchangeRate: numeric("exchange_rate", { precision: 10, scale: 4, mode: "number" }),

    // Para folios de transferencia, IDs de MercadoPago, o notas del operador (Ej. "Recibió billete falso")
    referenceInfo: text("reference_info"),

    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Libro de una reserva: SUM(amount) en cada abono/anulación e historial ordenado por fecha.
    index("idx_payments_booking_created").on(table.bookingId, table.createdAt),
  ],
);

/**
 * Catálogo GLOBAL de plantillas de vehículos (sin agencyId): lo administra TripAgent y lo comparten
 * todas las agencias. Fuente versionada: src/db/catalog/vehicle-templates.catalog.ts
 * (`npm run vehicle-templates:sync`). Las plantillas son inmutables: para cambiar un croquis se
 * crea otro `code` y se desactiva el anterior.
 */
export const vehicleTemplates = pgTable("vehicle_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description").default("").notNull(),
  layoutMap: jsonb("layout_map").$type<LayoutMap>().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

/**
 * Unidades de la agencia que se asignan a los tours (tours.vehicleId).
 * `templateId` indica de qué plantilla del catálogo se creó; `layoutMap` es una COPIA del croquis
 * de la plantilla al momento de crearla, para que los asientos de tours existentes nunca cambien.
 * `templateId` nulo = vehículo anterior al catálogo o creado a mano por API.
 */
export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(), // 🚀 Multi-Tenant: Cada plantilla pertenece a una sola agencia
    templateId: uuid("template_id").references(() => vehicleTemplates.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 100 }).notNull(),
    layoutMap: jsonb("layout_map").$type<LayoutMap>().notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // Una sola unidad por (agencia, plantilla): la asignación desde el catálogo hace find-or-create.
  (table) => [
    uniqueIndex("idx_vehicles_agency_template")
      .on(table.agencyId, table.templateId)
      .where(sql`${table.templateId} IS NOT NULL`),
    // Unidades de la agencia (GET /vehicles).
    index("idx_vehicles_agency").on(table.agencyId),
  ],
);

export const tourBlockedSeats = pgTable(
  "tour_blocked_seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tourId: uuid("tour_id")
      .references(() => tours.id, { onDelete: "cascade" })
      .notNull(),
    seatLabel: varchar("seat_label", { length: 10 }).notNull(),
    reason: varchar("reason", { length: 255 }).default("STAFF"),
  },
  (table) => [uniqueIndex("idx_unique_blocked_seat").on(table.tourId, table.seatLabel)],
);

// ============================================================================
// NOTIFICATIONS (avisos in-app de acciones del viajero; 2026-11-22)
// ============================================================================
/**
 * Solo las generan acciones públicas del viajero (regla anti-ruido): pre-reserva del folleto
 * (`PRE_BOOKING`) y registro del grupo en el Magic Link (`BOOKING_COMPLETED`). Las acciones del
 * operador no generan avisos. `isRead` es de la agencia, no de cada usuario: si un operador la
 * atiende, deja de estar pendiente para todos (así dos operadores no contactan al mismo cliente).
 * `travelerName` y `tourTitle` son una foto del momento del evento.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .references(() => agencies.id, { onDelete: "cascade" })
      .notNull(),
    tourId: uuid("tour_id")
      .references(() => tours.id, { onDelete: "cascade" })
      .notNull(),
    bookingId: uuid("booking_id")
      .references(() => bookings.id, { onDelete: "cascade" })
      .notNull(),
    // NOTIFICATION_TYPES (shared/constants/domain.constants.ts): PRE_BOOKING | BOOKING_COMPLETED.
    type: varchar("type", { length: 30 }).notNull(),
    travelerName: varchar("traveler_name", { length: 120 }).notNull(),
    tourTitle: varchar("tour_title", { length: 160 }).notNull(),
    seatsCount: integer("seats_count").notNull(),
    isRead: boolean("is_read").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Últimas 20 de la agencia (ORDER BY created_at DESC).
    index("idx_notifications_agency_created").on(table.agencyId, table.createdAt.desc()),
    // Conteo de no leídas y "marcar todas como leídas".
    index("idx_notifications_agency_unread").on(table.agencyId, table.isRead),
  ],
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.bookingId],
    references: [bookings.id],
  }),
  agency: one(agencies, {
    fields: [payments.agencyId],
    references: [agencies.id],
  }),
  createdByUser: one(agencyUsers, {
    fields: [payments.createdByUserId],
    references: [agencyUsers.id],
  }),
}));

// ============================================================================
// 9. RELACIONES (Drizzle Query API)
// ============================================================================

// Relaciones para Bookings (Una reserva pertenece a un Viajero y a un Tour)
export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  traveler: one(travelers, {
    fields: [bookings.travelerId],
    references: [travelers.id],
  }),
  tour: one(tours, {
    fields: [bookings.tourId],
    references: [tours.id],
  }),
  agency: one(agencies, {
    fields: [bookings.agencyId],
    references: [agencies.id],
  }),
  passengers: many(bookingPassengers),
  magicToken: one(magicTokens, {
    fields: [bookings.id],
    references: [magicTokens.bookingId],
  }),
  payments: many(payments),
}));

// Relaciones Inversas para Travelers (Un viajero puede tener muchas reservas)
export const travelersRelations = relations(travelers, ({ many, one }) => ({
  bookings: many(bookings),
  agency: one(agencies, {
    fields: [travelers.agencyId],
    references: [agencies.id],
  }),
}));

// Relaciones Inversas para Tours
export const toursRelations = relations(tours, ({ many, one }) => ({
  bookings: many(bookings),
  magicTokens: many(magicTokens),
  agency: one(agencies, {
    fields: [tours.agencyId],
    references: [agencies.id],
  }),
  vehicle: one(vehicles, {
    fields: [tours.vehicleId],
    references: [vehicles.id],
  }),
  createdByUser: one(agencyUsers, {
    fields: [tours.createdByUserId],
    references: [agencyUsers.id],
  }),
  updatedByUser: one(agencyUsers, {
    fields: [tours.updatedByUserId],
    references: [agencyUsers.id],
  }),
}));

export const bookingPassengersRelations = relations(bookingPassengers, ({ one }) => ({
  booking: one(bookings, {
    fields: [bookingPassengers.bookingId],
    references: [bookings.id],
  }),
  traveler: one(travelers, {
    fields: [bookingPassengers.travelerId],
    references: [travelers.id],
  }),
}));

export const magicTokensRelations = relations(magicTokens, ({ one }) => ({
  tour: one(tours, {
    fields: [magicTokens.tourId],
    references: [tours.id],
  }),

  agency: one(agencies, {
    fields: [magicTokens.agencyId],
    references: [agencies.id],
  }),
  booking: one(bookings, {
    fields: [magicTokens.bookingId],
    references: [bookings.id],
  }),
}));

// Relaciones del Usuario
export const agencyUsersRelations = relations(agencyUsers, ({ one }) => ({
  agency: one(agencies, {
    fields: [agencyUsers.agencyId],
    references: [agencies.id],
  }),
}));

// Actualiza tus relaciones de `agencies` existentes para incluir a los usuarios:
export const agenciesRelations = relations(agencies, ({ one, many }) => ({
  branding: one(agencyBranding),
  users: many(agencyUsers),
  travelers: many(travelers),
  tours: many(tours),
  bookings: many(bookings),
  magicTokens: many(magicTokens),
  payments: many(payments),
  vehicles: many(vehicles),
}));

export const agencyBrandingRelations = relations(agencyBranding, ({ one }) => ({
  agency: one(agencies, { fields: [agencyBranding.agencyId], references: [agencies.id] }),
}));

// Relación inversa opcional pero recomendada (Un vehículo puede usarse en muchos tours)
export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  agency: one(agencies, {
    fields: [vehicles.agencyId],
    references: [agencies.id],
  }),
  template: one(vehicleTemplates, {
    fields: [vehicles.templateId],
    references: [vehicleTemplates.id],
  }),
  tours: many(tours),
}));

export const vehicleTemplatesRelations = relations(vehicleTemplates, ({ many }) => ({
  vehicles: many(vehicles),
}));
