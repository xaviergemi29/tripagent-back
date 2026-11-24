ALTER TYPE "public"."subscription_status" ADD VALUE 'cancel_scheduled';--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "subscription_period_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "subscription_canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "subscription_cancellation_reason" varchar(30);--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "subscription_cancellation_comment" text;