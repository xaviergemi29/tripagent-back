ALTER TABLE "agencies" ADD COLUMN "bank_name" varchar(100);--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "bank_account_holder" varchar(255);--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "clabe_number" varchar(18);--> statement-breakpoint
ALTER TABLE "tours" DROP COLUMN "bank_details";