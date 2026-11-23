CREATE TYPE "public"."lodging_room_type" AS ENUM('MATRIMONIAL', 'DOUBLE_INDIVIDUAL', 'TRIPLE', 'QUADRUPLE');--> statement-breakpoint
CREATE TABLE "tour_hotel_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"tour_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_number" varchar(10) NOT NULL,
	"room_type" "lodging_room_type" NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tour_hotels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"tour_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD CONSTRAINT "tour_hotel_rooms_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD CONSTRAINT "tour_hotel_rooms_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD CONSTRAINT "tour_hotel_rooms_hotel_id_tour_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."tour_hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotels" ADD CONSTRAINT "tour_hotels_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotels" ADD CONSTRAINT "tour_hotels_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotels" ADD CONSTRAINT "tour_hotels_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tour_hotel_rooms_hotel_number" ON "tour_hotel_rooms" USING btree ("hotel_id","room_number");--> statement-breakpoint
CREATE INDEX "idx_tour_hotel_rooms_tour" ON "tour_hotel_rooms" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "idx_tour_hotels_tour" ON "tour_hotels" USING btree ("tour_id");