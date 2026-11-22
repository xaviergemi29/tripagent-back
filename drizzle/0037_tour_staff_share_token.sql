ALTER TABLE "tours" ADD COLUMN "staff_share_token" text;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "staff_share_token_created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_staff_share_token_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("staff_share_token_created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tours_staff_share_token" ON "tours" USING btree ("staff_share_token");