/**
 * Convierte a E.164 los teléfonos capturados antes del selector de lada (2026-11-16).
 *
 *   npm run phones:normalize            # solo reporte (lee Neon, no escribe)
 *   npm run phones:normalize -- --apply # respalda y convierte (escribe en Neon: requiere autorización)
 *
 * Reglas:
 * - Un valor que ya está en E.164 válido no se toca.
 * - Uno de 10 dígitos (o "+" + 10 dígitos, o 52 + 10 dígitos) se interpreta como mexicano, que es lo
 *   que el sistema ya hacía al armar los enlaces `wa.me`. El **país se deja en NULL**: la lada queda
 *   "sin confirmar" y se confirma cuando el operador edita al viajero o el cliente se registra.
 * - `""` (formulario pendiente del contacto de emergencia) y NULL se conservan.
 * - Inválidos y choques (dos viajeros activos de la misma agencia que quedarían con el mismo número,
 *   lo que violaría el índice único) **no se tocan**: se listan para revisión manual.
 * - Con `--apply`, cada valor original se guarda antes en `phone_normalization_backup` (tabla fuera
 *   de Drizzle, solo para revertir) y todo ocurre en una transacción.
 */
import { sql } from "drizzle-orm";
import { db, closeDb } from "./index.js";
import { agencies, travelers } from "./schema.js";
import { normalizePhone } from "../shared/utils/phone.util.js";

type Column = "whatsapp_phone" | "emergency_contact_phone" | "phone";

interface Change {
  table: "travelers" | "agencies";
  rowId: string;
  column: Column;
  original: string;
  normalized: string;
}

interface Problem {
  table: string;
  rowId: string;
  column: Column;
  value: string;
  reason: string;
}

const isE164 = (value: string): boolean => value.startsWith("+") && normalizePhone(value) === value;

function classify(
  table: Change["table"],
  rowId: string,
  column: Column,
  value: string | null,
  changes: Change[],
  problems: Problem[],
  counters: Record<string, number>,
): void {
  if (value === null || value.trim() === "") {
    counters.empty = (counters.empty ?? 0) + 1;
    return;
  }
  if (isE164(value)) {
    counters.alreadyE164 = (counters.alreadyE164 ?? 0) + 1;
    return;
  }
  const normalized = normalizePhone(value);
  if (!normalized) {
    problems.push({ table, rowId, column, value, reason: "No es un número válido" });
    return;
  }
  changes.push({ table, rowId, column, original: value, normalized });
}

async function normalizePhones() {
  const apply = process.argv.includes("--apply");
  const counters: Record<string, number> = {};
  const changes: Change[] = [];
  const problems: Problem[] = [];

  const travelerRows = await db
    .select({
      id: travelers.id,
      agencyId: travelers.agencyId,
      whatsappPhone: travelers.whatsappPhone,
      emergencyContactPhone: travelers.emergencyContactPhone,
      deletedAt: travelers.deletedAt,
    })
    .from(travelers);
  const agencyRows = await db.select({ id: agencies.id, phone: agencies.phone }).from(agencies);

  for (const row of travelerRows) {
    classify("travelers", row.id, "whatsapp_phone", row.whatsappPhone, changes, problems, counters);
    classify(
      "travelers",
      row.id,
      "emergency_contact_phone",
      row.emergencyContactPhone,
      changes,
      problems,
      counters,
    );
  }
  for (const row of agencyRows) {
    classify("agencies", row.id, "phone", row.phone, changes, problems, counters);
  }

  // Choques del índice único (agencia, WhatsApp) entre viajeros no borrados.
  const finalWhatsapp = new Map<string, string[]>();
  for (const row of travelerRows) {
    if (row.deletedAt || !row.whatsappPhone?.trim()) continue;
    const change = changes.find(
      (c) => c.table === "travelers" && c.rowId === row.id && c.column === "whatsapp_phone",
    );
    const finalValue = change?.normalized ?? row.whatsappPhone;
    const key = `${row.agencyId}|${finalValue}`;
    finalWhatsapp.set(key, [...(finalWhatsapp.get(key) ?? []), row.id]);
  }
  const collidingIds = new Set<string>();
  for (const [key, ids] of finalWhatsapp) {
    if (ids.length < 2) continue;
    const [, value = ""] = key.split("|");
    for (const id of ids) {
      collidingIds.add(id);
      problems.push({
        table: "travelers",
        rowId: id,
        column: "whatsapp_phone",
        value,
        reason: `Choque: mismo número que ${ids.filter((other) => other !== id).join(", ")}`,
      });
    }
  }
  const safeChanges = changes.filter(
    (c) => !(c.table === "travelers" && c.column === "whatsapp_phone" && collidingIds.has(c.rowId)),
  );

  console.log("📞 Normalización de teléfonos a E.164");
  console.log(`   Vacíos (se conservan):        ${counters.empty ?? 0}`);
  console.log(`   Ya en E.164:                  ${counters.alreadyE164 ?? 0}`);
  console.log(`   Por convertir:                ${safeChanges.length}`);
  console.log(`   Para revisión manual:         ${problems.length}`);
  for (const p of problems) {
    console.log(`   ⚠ ${p.table}.${p.column} ${p.rowId}: "${p.value}" → ${p.reason}`);
  }

  if (!apply) {
    for (const c of safeChanges.slice(0, 20)) {
      console.log(`   · ${c.table}.${c.column} ${c.rowId}: ${c.original} → ${c.normalized}`);
    }
    if (safeChanges.length > 20) console.log(`   … y ${safeChanges.length - 20} más`);
    console.log("\nSolo reporte. Para escribir: npm run phones:normalize -- --apply");
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS phone_normalization_backup (
        id serial PRIMARY KEY,
        table_name text NOT NULL,
        row_id uuid NOT NULL,
        column_name text NOT NULL,
        original_value text NOT NULL,
        normalized_value text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    for (const c of safeChanges) {
      await tx.execute(sql`
        INSERT INTO phone_normalization_backup
          (table_name, row_id, column_name, original_value, normalized_value)
        VALUES (${c.table}, ${c.rowId}, ${c.column}, ${c.original}, ${c.normalized})`);
      // Tabla y columna salen de una lista cerrada (no del usuario).
      await tx.execute(sql`
        UPDATE ${sql.identifier(c.table)}
        SET ${sql.identifier(c.column)} = ${c.normalized}
        WHERE id = ${c.rowId} AND ${sql.identifier(c.column)} = ${c.original}`);
    }
  });
  console.log(
    `\n✅ ${safeChanges.length} teléfonos convertidos (respaldo en phone_normalization_backup).`,
  );
}

normalizePhones()
  .catch((error) => {
    console.error("❌ Error al normalizar teléfonos:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
