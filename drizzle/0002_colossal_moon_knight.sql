CREATE TYPE "public"."passenger_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'TRANSFER', 'CARD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."payment_type" AS ENUM('PAYMENT', 'REFUND');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"type" "payment_type" DEFAULT 'PAYMENT' NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"reference_info" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD COLUMN "status" "passenger_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;