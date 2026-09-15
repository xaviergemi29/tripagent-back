CREATE TYPE "public"."transport_modality" AS ENUM('TRANSPORT_INCLUDED', 'INDEPENDENT_ACCESS');--> statement-breakpoint
CREATE TABLE "tours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"tour_recommendations" text NOT NULL,
	"transport_modality" "transport_modality" DEFAULT 'TRANSPORT_INCLUDED' NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"duration_hours" integer NOT NULL,
	"meeting_point" text NOT NULL,
	"departure_date_time" timestamp with time zone NOT NULL,
	"max_capacity" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"accepts_bank_transfer" boolean DEFAULT false NOT NULL,
	"bank_details" text,
	"accepts_credit_card" boolean DEFAULT false NOT NULL,
	"payment_link" text,
	"post_payment_instructions" text NOT NULL,
	"accepts_cash" boolean DEFAULT false NOT NULL,
	"cash_instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travelers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"whatsapp_phone" varchar(20) NOT NULL,
	"email" varchar(255) NOT NULL,
	"emergency_contact_name" varchar(255) NOT NULL,
	"emergency_contact_phone" varchar(20) NOT NULL,
	"medical_notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
