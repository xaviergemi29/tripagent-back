CREATE TYPE "public"."lodging_room_status" AS ENUM('CONSULTED', 'CONFIRMED');--> statement-breakpoint
CREATE TABLE "tour_hotel_room_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"tour_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"slot_index" integer NOT NULL,
	"booking_passenger_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_tour_hotel_rooms_hotel_number";--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ALTER COLUMN "room_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD COLUMN "position" integer;--> statement-breakpoint
-- Habitaciones existentes: posición 1..n por hotel en su orden de alta (conservan su room_number).
UPDATE "tour_hotel_rooms" AS r SET "position" = ordered."position" FROM (
	SELECT "id", row_number() OVER (PARTITION BY "hotel_id" ORDER BY "created_at", "room_number", "id")::integer AS "position"
	FROM "tour_hotel_rooms"
) AS ordered WHERE r."id" = ordered."id";--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD COLUMN "status" "lodging_room_status" DEFAULT 'CONSULTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_hotel_id_tour_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."tour_hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_room_id_tour_hotel_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."tour_hotel_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_booking_passenger_id_booking_passengers_id_fk" FOREIGN KEY ("booking_passenger_id") REFERENCES "public"."booking_passengers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_hotel_room_assignments" ADD CONSTRAINT "tour_hotel_room_assignments_assigned_by_user_id_agency_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_room_assignments_room_slot" ON "tour_hotel_room_assignments" USING btree ("room_id","slot_index");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_room_assignments_hotel_passenger" ON "tour_hotel_room_assignments" USING btree ("hotel_id","booking_passenger_id");--> statement-breakpoint
CREATE INDEX "idx_room_assignments_tour" ON "tour_hotel_room_assignments" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "idx_tour_hotel_rooms_hotel_position" ON "tour_hotel_rooms" USING btree ("hotel_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tour_hotel_rooms_hotel_number" ON "tour_hotel_rooms" USING btree ("hotel_id","room_number") WHERE "tour_hotel_rooms"."room_number" IS NOT NULL;