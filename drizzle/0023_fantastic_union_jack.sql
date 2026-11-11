CREATE TYPE "public"."destination_type" AS ENUM('NATIONAL', 'INTERNATIONAL');--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "destination_type" "destination_type" DEFAULT 'NATIONAL' NOT NULL;