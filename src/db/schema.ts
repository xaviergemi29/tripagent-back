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
  date,
} from "drizzle-orm/pg-core";

export const SEAT_STATUS = pgEnum("seat_status", ["AVAILABLE", "ASSIGNED", "BLOCKED"]);

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
  slug: varchar({ length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }),
  logoUrl: text("logo_url"),
  email: varchar("email", { length: 255 }).notNull(),
  // Control de Suscripción
  subscriptionStatus: SUBSCRIPTION_STATUS("subscription_status").default("trialing").notNull(),
  trialEndsAt: timestamp("trial_ends_at", { mode: "string", withTimezone: true }),

  isActive: boolean("is_active").default(true).notNull(),
  // Timestamps y Soft Delete
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }), // ✅ Soft Delete
});

// ============================================================================
// 2 AGENCY USERS (Operadores, Guías y Agentes de IA)
// ============================================================================
export const agencyUsers = pgTable("agency_users", {
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
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

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
    whatsappPhone: varchar("whatsapp_phone", { length: 20 }),
    email: varchar("email", { length: 255 }),

    emergencyContactName: varchar("emergency_contact_name", { length: 255 }).notNull(),
    emergencyContactPhone: varchar("emergency_contact_phone", { length: 20 }).notNull(),
    medicalNotes: text("medical_notes"),
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
  ],
);

// ============================================================================
// 4. TOURS
// ============================================================================

export const tours = pgTable("tours", {
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

  title: varchar("title", { length: 100 }).notNull(),
  // 🛡️ CAMPOS OCULTOS TEMPORALMENTE (MVP):
  description: text("description").default("").notNull(),
  tourRecommendations: text("tour_recommendations").default("").notNull(),

  transportModality: TOUR_MODALITIES("transport_modality").default("TRANSPORT_INCLUDED").notNull(),
  price: numeric("price", { precision: 10, scale: 2, mode: "number" }).notNull(),
  depositPerPerson: numeric("deposit_per_person", { precision: 10, scale: 2, mode: "number" })
    .default(0)
    .notNull(),
  durationHours: integer("duration_hours").default(1).notNull(),
  // meetingPoint: text("meeting_point").notNull(),
  departureDateTime: date("departure_date_time", { mode: "string" }).notNull(),
  maxCapacity: integer("max_capacity").notNull(),
  isActive: boolean("is_active").default(true).notNull(),

  // Configuración de cobro
  acceptsBankTransfer: boolean("accepts_bank_transfer").default(false).notNull(),
  bankDetails: text("bank_details"),
  acceptsCreditCard: boolean("accepts_credit_card").default(false).notNull(),
  paymentLink: text("payment_link"),
  // 🛡️ CAMPOS OCULTOS TEMPORALMENTE (MVP):
  ppostPaymentInstructions: text("post_payment_instructions").default("").notNull(),

  acceptsCash: boolean("accepts_cash").default(false).notNull(),
  cashInstructions: text("cash_instructions"),
  boardingPoints: jsonb("boarding_points")
    .$type<{ id: string; time: string; location: string }[]>()
    .default([])
    .notNull(),
  brochureUrl: text("brochure_url"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { mode: "string", withTimezone: true }),
});

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
    totalPrice: numeric("total_price", { precision: 10, scale: 2, mode: "number" }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 10, scale: 2, mode: "number" })
      .default(0)
      .notNull(),

    // Vía de pago del anticipo/total (Cash, Transfer, Card)
    lastPaymentMethod: PAYMENT_METHOD("last_payment_method"),

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
  },
  (table) => [
    // 🛡️ ÚNICO ACTIVO: Bloquea duplicados SOLO si el estatus es ACTIVE.
    // Si está CANCELLED, el índice lo ignora, permitiendo que la persona regrese después.
    uniqueIndex("idx_unique_active_booking_traveler")
      .on(table.bookingId, table.travelerId)
      .where(sql`${table.status} <> 'CANCELLED'`),
  ],
);

// ============================================================================
// 7. MAGIC TOKENS
// ============================================================================
export const magicTokens = pgTable("magic_tokens", {
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
  maxUses: integer("max_uses").notNull(),
  currentUses: integer("current_uses").default(0).notNull(),

  // Tiempo de vida del enlace
  expiresAt: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),

  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 8. PAYMENTS (Libro Mayor de Transacciones)
// ============================================================================
export const payments = pgTable("payments", {
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

  // Para folios de transferencia, IDs de MercadoPago, o notas del operador (Ej. "Recibió billete falso")
  referenceInfo: text("reference_info"),

  // Quién registró el pago (Si luego implementas usuarios del sistema, aquí iría su UUID)
  // registeredBy: uuid("registered_by"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .references(() => agencies.id, { onDelete: "cascade" })
    .notNull(), // 🚀 Multi-Tenant: Cada plantilla pertenece a una sola agencia
  name: varchar("name", { length: 100 }).notNull(),
  layoutMap: jsonb("layout_map").$type<(string | null)[][]>().notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
});

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
    // 👈 NUEVO: Relación 1 a 1 con el token
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
}));

// Relaciones del Usuario
export const agencyUsersRelations = relations(agencyUsers, ({ one }) => ({
  agency: one(agencies, {
    fields: [agencyUsers.agencyId],
    references: [agencies.id],
  }),
}));

// Actualiza tus relaciones de `agencies` existentes para incluir a los usuarios:
export const agenciesRelations = relations(agencies, ({ many }) => ({
  users: many(agencyUsers),
  travelers: many(travelers),
  tours: many(tours),
  bookings: many(bookings),
  magicTokens: many(magicTokens),
  payments: many(payments),
  vehicles: many(vehicles),
}));

// Relación inversa opcional pero recomendada (Un vehículo puede usarse en muchos tours)
export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  agency: one(agencies, {
    fields: [vehicles.agencyId],
    references: [agencies.id],
  }),
  tours: many(tours),
}));
