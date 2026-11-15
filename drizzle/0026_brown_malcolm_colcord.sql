CREATE TABLE "agency_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"primary_color" varchar(7) DEFAULT '#4f46e5' NOT NULL,
	"secondary_color" varchar(7) DEFAULT '#4338ca' NOT NULL,
	"accent_color" varchar(7),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_branding_agency_id_unique" UNIQUE("agency_id")
);
--> statement-breakpoint
ALTER TABLE "agencies" RENAME COLUMN "logo_url" TO "logo_path";--> statement-breakpoint
ALTER TABLE "agency_branding" ADD CONSTRAINT "agency_branding_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Limpieza de datos (agregada a mano): logo_path guarda la ruta de un archivo subido a public/ (/uploads/logos/...). Los valores anteriores eran URLs de ejemplo (p. ej. https://cdn.tripagent.com/...) que no corresponden a ningún archivo.
UPDATE "agencies" SET "logo_path" = NULL WHERE "logo_path" IS NOT NULL AND "logo_path" NOT LIKE '/uploads/%';
