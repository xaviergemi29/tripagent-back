CREATE TYPE "public"."booking_status" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."passenger_type" AS ENUM('ADULT', 'CHILD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'PARTIAL', 'PAID', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"phone" varchar(20),
	"logo_url" text,
	"email" varchar(255) NOT NULL,
	"subscription_status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agencies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "booking_passengers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"traveler_id" uuid NOT NULL,
	"is_titular" boolean DEFAULT false NOT NULL,
	"passenger_type" "passenger_type" DEFAULT 'ADULT' NOT NULL,
	"boarding_point" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"tour_id" uuid NOT NULL,
	"traveler_id" uuid NOT NULL,
	"group_reference" varchar(100),
	"booking_status" "booking_status" DEFAULT 'PENDING' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"total_price" numeric(10, 2) NOT NULL,
	"amount_paid" numeric(10, 2) DEFAULT 0 NOT NULL,
	"last_payment_method" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "magic_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"tour_id" uuid NOT NULL,
	"token" varchar(255) NOT NULL,
	"max_uses" integer NOT NULL,
	"current_uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "tours" ALTER COLUMN "departure_date_time" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "travelers" ALTER COLUMN "whatsapp_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "travelers" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "agency_id" uuid;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "boarding_points" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "travelers" ADD COLUMN "agency_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "travelers" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "travelers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "travelers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD CONSTRAINT "booking_passengers_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD CONSTRAINT "booking_passengers_traveler_id_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."travelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_traveler_id_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."travelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_tokens" ADD CONSTRAINT "magic_tokens_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_tokens" ADD CONSTRAINT "magic_tokens_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_unique_active_tour_traveler" ON "bookings" USING btree ("tour_id","traveler_id") WHERE "bookings"."booking_status" <> 'CANCELLED';--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travelers" ADD CONSTRAINT "travelers_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_unique_agency_whatsapp" ON "travelers" USING btree ("agency_id","whatsapp_phone") WHERE "travelers"."whatsapp_phone" IS NOT NULL AND "travelers"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tours" DROP COLUMN "meeting_point";