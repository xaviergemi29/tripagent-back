ALTER TABLE "bookings" ADD COLUMN "unit_price" numeric(10, 2);--> statement-breakpoint
-- Precio pactado por lugar de las reservas existentes (2026-11-17). Reservas vigentes: total ÷ lugares
-- apartados (el total se calculó como precio × lugares y la interfaz nunca aplicó retenciones en
-- las bajas). Canceladas o sin token: el precio actual del tour (su total ya es la retención).
UPDATE "bookings" AS b
SET "unit_price" = ROUND(b."total_price" / mt."number_passengers", 2)
FROM "magic_tokens" AS mt
WHERE mt."booking_id" = b."id"
  AND mt."number_passengers" > 0
  AND b."booking_status" <> 'CANCELLED';--> statement-breakpoint
UPDATE "bookings" AS b
SET "unit_price" = t."price"
FROM "tours" AS t
WHERE t."id" = b."tour_id"
  AND b."unit_price" IS NULL;
