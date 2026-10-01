CREATE TYPE "public"."currency" AS ENUM('MXN', 'USD');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "currency" "currency" DEFAULT 'MXN' NOT NULL;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "currency" "currency" DEFAULT 'MXN' NOT NULL;