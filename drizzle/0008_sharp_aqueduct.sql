CREATE TYPE "public"."seat_status" AS ENUM('AVAILABLE', 'ASSIGNED', 'BLOCKED');--> statement-breakpoint
CREATE TABLE "tour_blocked_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tour_id" uuid NOT NULL,
	"seat_label" varchar(10) NOT NULL,
	"reason" varchar(255) DEFAULT 'STAFF'
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"layout_map" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_passengers" ADD COLUMN "seat_label" varchar(10);--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "tour_blocked_seats" ADD CONSTRAINT "tour_blocked_seats_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_unique_blocked_seat" ON "tour_blocked_seats" USING btree ("tour_id","seat_label");--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;