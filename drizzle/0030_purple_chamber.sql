ALTER TABLE "agencies" ADD COLUMN "privacy_notice_url" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "privacy_notice_accepted_at" timestamp with time zone;