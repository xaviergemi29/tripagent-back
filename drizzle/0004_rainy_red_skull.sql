CREATE TYPE "public"."agency_roles" AS ENUM('ADMIN', 'SALES', 'GUIDE');--> statement-breakpoint
CREATE TABLE "agency_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"role" "agency_roles" DEFAULT 'SALES' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "last_payment_method" SET DATA TYPE "public"."payment_method" USING "last_payment_method"::"public"."payment_method";--> statement-breakpoint
ALTER TABLE "tours" ALTER COLUMN "agency_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_users" ADD CONSTRAINT "agency_users_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_unique_active_booking_traveler" ON "booking_passengers" USING btree ("booking_id","traveler_id") WHERE "booking_passengers"."status" <> 'CANCELLED';