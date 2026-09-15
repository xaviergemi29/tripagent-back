import z, { email } from "zod";

export const loginBodySchema = z.object({
  email: z.email("Correo electrónico inválido").trim(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
