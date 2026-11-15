import { db } from "../db/index.js";
import { agencies, agencyUsers } from "../db/schema.js";
import bcrypt from "bcryptjs";
import { parseArgs } from "node:util";

/**
 * 🚀 Script CLI de Aprovisionamiento de Agencia (Tenant)
 *
 * Uso:
 * npm run tenant:create -- \
 *   --name="Bruji Tours" \
 *   --email="contacto@brujitours.com" \
 *   --phone="2281234567" \
 *   --adminName="Jackie Admin" \
 *   --adminPassword="PasswordSeguro123"
 *
 * El logotipo no se pasa aquí: la agencia lo sube como archivo desde Configuración
 * (POST /api/agencies/logo → agencies.logoPath).
 */
async function provisionTenant() {
  console.log("🌱 Iniciando aprovisionamiento del Tenant...");

  // 1. Parseo estricto de argumentos de linea de comandos
  const { values } = parseArgs({
    options: {
      name: { type: "string", short: "n" },
      email: { type: "string", short: "e" },
      phone: { type: "string", short: "t" },
      adminName: { type: "string", short: "u" },
      adminPassword: { type: "string", short: "p" },
    },
    strict: true,
  });

  const agencyName = values.name;
  const agencyEmail = values.email;
  const agencyPhone = values.phone;
  const adminName = values.adminName || `${agencyName} Admin`;
  const adminPassword = values.adminPassword;

  // 2. Validación de presencia de parámetros obligatorios
  if (!agencyName || !agencyEmail || !adminPassword) {
    console.error(
      "❌ Error: Faltan argumentos obligatorios.\n\n" +
        "Parámetros requeridos:\n" +
        '  --name="Nombre Agencia"\n' +
        '  --email="email@agencia.com"\n' +
        '  --adminPassword="Password123"\n\n' +
        "Parámetros opcionales:\n" +
        '  --phone="2281234567"\n' +
        '  --adminName="Nombre Administrador"\n',
    );
    process.exit(1);
  }

  try {
    // 3. Transacción ACID Única
    await db.transaction(async (tx) => {
      // --- A. INSERCIÓN DE AGENCIA ---
      const agencyRows = await tx
        .insert(agencies)
        .values({
          name: agencyName,
          email: agencyEmail.toLowerCase().trim(),
          phone: agencyPhone || null,
          subscriptionStatus: "trialing",
          isActive: true,
        })
        .returning({ id: agencies.id, name: agencies.name });

      const newAgency = agencyRows[0];
      if (!newAgency) {
        throw new Error("Fallo al insertar el registro de la agencia en PostgreSQL.");
      }

      // La tabla `agencies` no tiene slug: el script calculaba uno y lo imprimía como `undefined`.
      console.log(`✅ Agencia creada: ${newAgency.name} (ID: ${newAgency.id})`);

      // --- B. INSERCIÓN DE USUARIO ADMINISTRADOR ---
      const salt = await bcrypt.genSalt(12);
      const passwordHash = await bcrypt.hash(adminPassword, salt);

      const userRows = await tx
        .insert(agencyUsers)
        .values({
          agencyId: newAgency.id,
          email: agencyEmail.toLowerCase().trim(),
          passwordHash,
          fullName: adminName,
          role: "ADMIN",
          isActive: true,
        })
        .returning({ id: agencyUsers.id, email: agencyUsers.email });

      const newUser = userRows[0];
      if (!newUser) {
        throw new Error("Fallo al crear el usuario administrador inicial.");
      }

      console.log(`✅ Usuario Admin asociado: ${newUser.email}`);

      // Vehículos: no se clonan presets. El catálogo global (`vehicle_templates`) está disponible
      // para todas las agencias y la unidad de la agencia se crea al asignarla a su primer tour.
    });

    console.log("\n🚀 Tenant aprovisionado y listo para operar exitosamente.");
  } catch (error) {
    console.error(
      "\n❌ Error durante el aprovisionamiento. Transacción revertida (Rollback):",
      error,
    );
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

provisionTenant();
