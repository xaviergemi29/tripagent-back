import { db } from "./index.js";
import { agencyUsers } from "./schema.js";
import bcrypt from "bcryptjs";

async function seedAdmin() {
  console.log("🌱 Iniciando inyección de usuario administrador...");

  try {
    const agencyId = "d7a2eddf-ea66-4848-887c-d3cdd2e40e0d";
    const email = "jackie@brujitours.com";
    const plainTextPassword = "123456";

    // 1. Hashear la contraseña con un factor de costo seguro (10 o 12)
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(plainTextPassword, salt);

    // 2. Insertar el usuario
    const [newUser] = await db
      .insert(agencyUsers)
      .values({
        agencyId,
        email,
        passwordHash,
        fullName: "Jackie (Admin)",
        role: "ADMIN",
        isActive: true,
      })
      .returning({ id: agencyUsers.id, email: agencyUsers.email, role: agencyUsers.role });

    console.log("✅ Usuario Admin creado exitosamente:");
    console.table(newUser);
    console.log(`🔑 Credenciales -> Email: ${email} | Pass: ${plainTextPassword}`);
  } catch (error) {
    console.error("❌ Error al inyectar el admin:", error);
  } finally {
    process.exit(0);
  }
}

seedAdmin();
