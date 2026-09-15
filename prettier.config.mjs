/** @type {import("prettier").Config} */
const config = {
  // Trade-off: 80 es muy corto para pantallas modernas. 100 o 120 evita saltos de línea innecesarios.
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  // En TS/JS moderno se prefiere double quotes para strings, pero single quotes es muy común.
  // Next.js usa double quotes por defecto.
  singleQuote: false,
  // Crucial en Git: 'all' reduce conflictos de merge al agregar nuevas propiedades a un objeto
  trailingComma: "all",
  bracketSpacing: true,
};

export default config;
