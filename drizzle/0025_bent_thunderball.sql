CREATE TABLE "vehicle_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"layout_map" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_templates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_template_id_vehicle_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."vehicle_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_vehicles_agency_template" ON "vehicles" USING btree ("agency_id","template_id") WHERE "vehicles"."template_id" IS NOT NULL;