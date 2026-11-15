CREATE INDEX "idx_agency_users_agency" ON "agency_users" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "idx_booking_passengers_booking" ON "booking_passengers" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_booking_passengers_traveler" ON "booking_passengers" USING btree ("traveler_id");--> statement-breakpoint
CREATE INDEX "idx_bookings_tour" ON "bookings" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "idx_bookings_traveler" ON "bookings" USING btree ("traveler_id");--> statement-breakpoint
CREATE INDEX "idx_magic_tokens_booking" ON "magic_tokens" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_payments_booking_created" ON "payments" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tours_agency_created" ON "tours" USING btree ("agency_id","created_at") WHERE "tours"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_travelers_agency_created" ON "travelers" USING btree ("agency_id","created_at") WHERE "travelers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vehicles_agency" ON "vehicles" USING btree ("agency_id");