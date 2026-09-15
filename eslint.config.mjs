import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // 1. Ignorar carpetas generadas
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },

  // 2. Recomendados de JS y TypeScript
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // 3. Reglas personalizadas pragmáticas para Node.js
  {
    rules: {
      // En Node.js/Fastify a veces requerimos variables de desestructuración no usadas (ej. _request)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Evita anys accidentales en el servicio o repositorios
      "@typescript-eslint/no-explicit-any": "warn",
      // Esencial para Node: obliga a usar return o await en promesas dentro de try/catch
      "no-return-await": "error",
    },
  },

  // 4. Prettier SIEMPRE al final
  prettierConfig,
);
