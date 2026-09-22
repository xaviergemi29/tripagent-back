ALTER TABLE "booking_passengers" ADD COLUMN "seat_assigned_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD COLUMN "seat_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_tokens" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD CONSTRAINT "booking_passengers_seat_assigned_by_user_id_agency_users_id_fk" FOREIGN KEY ("seat_assigned_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_tokens" ADD CONSTRAINT "magic_tokens_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_updated_by_user_id_agency_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;