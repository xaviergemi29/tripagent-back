ALTER TABLE "payments" ADD COLUMN "currency" "currency" DEFAULT 'MXN' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "collected_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "collected_currency" "currency";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exchange_rate" numeric(10, 4);