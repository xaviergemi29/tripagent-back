ALTER TABLE "tours" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "cancellation_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "cancellation_note" varchar(200);