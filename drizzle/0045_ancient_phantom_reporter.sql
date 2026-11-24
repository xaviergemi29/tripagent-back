-- Múltiples cuentas bancarias por agencia (hasta 5). Editada a mano: al final copia la cuenta
-- actual de cada agencia (las columnas heredadas de "agencies" se conservan como respaldo).
CREATE TABLE "agency_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"bank_name" varchar(100) NOT NULL,
	"account_holder" varchar(255) NOT NULL,
	"clabe_number" varchar(18) NOT NULL,
	"card_number" varchar(16),
	"position" integer NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_bank_accounts" ADD CONSTRAINT "agency_bank_accounts_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_bank_accounts" ADD CONSTRAINT "agency_bank_accounts_created_by_user_id_agency_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_bank_accounts" ADD CONSTRAINT "agency_bank_accounts_updated_by_user_id_agency_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."agency_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agency_bank_accounts_agency" ON "agency_bank_accounts" USING btree ("agency_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_unique_agency_bank_account_clabe" ON "agency_bank_accounts" USING btree ("agency_id","clabe_number");
--> statement-breakpoint
-- Copia la cuenta heredada (solo agencias con CLABE capturada) como su primera cuenta (position 1).
-- Banco o titular vacíos se copian como '' (el front muestra "Banco/Titular sin capturar").
INSERT INTO "agency_bank_accounts" ("agency_id", "bank_name", "account_holder", "clabe_number", "card_number", "position")
SELECT "id", COALESCE("bank_name", ''), COALESCE("bank_account_holder", ''), TRIM("clabe_number"), NULLIF(TRIM("card_number"), ''), 1
FROM "agencies"
WHERE "clabe_number" IS NOT NULL AND TRIM("clabe_number") <> '';
