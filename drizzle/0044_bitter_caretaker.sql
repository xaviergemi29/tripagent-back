-- Camas por habitación (regla 27). Editada a mano: las columnas se agregan con DEFAULT 0 para las
-- filas existentes, se rellenan desde el tipo heredado y después se quita el default (cada alta
-- nueva envía sus camas).
ALTER TABLE "tour_hotel_rooms" ALTER COLUMN "room_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD COLUMN "matrimonial_beds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ADD COLUMN "single_beds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Tipo vigente: el guardado si su capacidad coincide; si no (habitación a la que se le quitó un
-- lugar antes de que el tipo siguiera a la capacidad), el de su capacidad actual con la regla de
-- entonces: 1 → SINGLE, 2 → DOUBLE_INDIVIDUAL, 3 → TRIPLE, 4 → QUADRUPLE. La capacidad no cambia.
-- Camas por tipo: SINGLE 0/1, MATRIMONIAL 1/0, DOUBLE_INDIVIDUAL 0/2, TRIPLE 1/1, QUADRUPLE 2/0.
WITH "effective" AS (
  SELECT
    "id",
    CASE
      WHEN ("room_type" = 'SINGLE' AND "capacity" = 1)
        OR ("room_type" IN ('MATRIMONIAL', 'DOUBLE_INDIVIDUAL') AND "capacity" = 2)
        OR ("room_type" = 'TRIPLE' AND "capacity" = 3)
        OR ("room_type" = 'QUADRUPLE' AND "capacity" = 4) THEN "room_type"
      WHEN "capacity" = 1 THEN 'SINGLE'::"lodging_room_type"
      WHEN "capacity" = 2 THEN 'DOUBLE_INDIVIDUAL'::"lodging_room_type"
      WHEN "capacity" = 3 THEN 'TRIPLE'::"lodging_room_type"
      WHEN "capacity" = 4 THEN 'QUADRUPLE'::"lodging_room_type"
      ELSE "room_type"
    END AS "room_type"
  FROM "tour_hotel_rooms"
)
UPDATE "tour_hotel_rooms" AS "room"
SET
  "room_type" = "effective"."room_type",
  "matrimonial_beds" = CASE "effective"."room_type"
    WHEN 'MATRIMONIAL' THEN 1
    WHEN 'TRIPLE' THEN 1
    WHEN 'QUADRUPLE' THEN 2
    ELSE 0
  END,
  "single_beds" = CASE "effective"."room_type"
    WHEN 'SINGLE' THEN 1
    WHEN 'DOUBLE_INDIVIDUAL' THEN 2
    WHEN 'TRIPLE' THEN 1
    ELSE 0
  END
FROM "effective"
WHERE "room"."id" = "effective"."id";--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ALTER COLUMN "matrimonial_beds" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tour_hotel_rooms" ALTER COLUMN "single_beds" DROP DEFAULT;
