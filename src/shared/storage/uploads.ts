import fs from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Archivos subidos (folletos PDF y logotipos) en `public/uploads/<carpeta>`, servidos por
 * @fastify/static en `<origen API>/public/uploads/…` (sin `/api`). En BD se guarda la ruta pública
 * (`/uploads/<carpeta>/<archivo>`), nunca una ruta absoluta del disco.
 *
 * Única implementación de: carpetas, escritura por stream, validación por firma (magic bytes) y
 * borrado seguro. Si en el futuro se migra a almacenamiento en la nube (S3/R2), este es el único
 * módulo que cambia.
 */
export const UPLOAD_DIRS = {
  brochures: path.join(process.cwd(), "public", "uploads", "brochures"),
  logos: path.join(process.cwd(), "public", "uploads", "logos"),
} as const;

export type UploadFolder = keyof typeof UPLOAD_DIRS;

/** Crea las carpetas de subida si no existen (idempotente; se llama al registrar las rutas). */
export function ensureUploadDirs(): void {
  for (const dir of Object.values(UPLOAD_DIRS)) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** Ruta pública que se guarda en BD para un archivo de la carpeta. */
export const toPublicUploadPath = (folder: UploadFolder, fileName: string) =>
  `/uploads/${folder}/${fileName}`;

/**
 * Escribe el stream del archivo multipart en la carpeta y devuelve la ruta absoluta. Si la
 * escritura falla, borra el archivo parcial y relanza el error.
 */
export async function writeUpload(
  folder: UploadFolder,
  fileName: string,
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const absolutePath = path.join(UPLOAD_DIRS[folder], path.basename(fileName));
  try {
    await pipeline(stream as unknown as Readable, fs.createWriteStream(absolutePath));
  } catch (error) {
    // Archivo que excede el límite a mitad del stream (FST_REQ_FILE_TOO_LARGE) o error de disco:
    // no se deja el archivo parcial.
    await removeAbsoluteFile(absolutePath);
    throw error;
  }
  return absolutePath;
}

/**
 * Firmas de archivo aceptadas. El `mimetype` del multipart lo declara el cliente y se puede
 * falsificar; la firma (primeros bytes) confirma que el contenido es realmente PDF / PNG / JPEG.
 */
const FILE_SIGNATURES = {
  pdf: [Buffer.from("%PDF-", "ascii")],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
} as const;

export type FileKind = keyof typeof FILE_SIGNATURES;

/** ¿El archivo en disco empieza con la firma del tipo esperado? */
export async function hasFileSignature(absolutePath: string, kind: FileKind): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return FILE_SIGNATURES[kind].some(
      (signature) =>
        bytesRead >= signature.length && header.subarray(0, signature.length).equals(signature),
    );
  } finally {
    await handle.close();
  }
}

/**
 * Borra el archivo de una ruta pública guardada en BD. Solo actúa dentro de la carpeta indicada y,
 * si se pasa `requiredPrefix`, solo sobre archivos cuyo nombre empieza con él (p. ej. `tour-<id>-`),
 * para que un valor manipulado nunca borre el archivo de otro tour u otra agencia. Ignora archivos
 * que ya no existen.
 */
export async function removeUpload(
  folder: UploadFolder,
  publicPath: string | null | undefined,
  requiredPrefix?: string,
): Promise<void> {
  const prefix = `/uploads/${folder}/`;
  if (!publicPath?.startsWith(prefix)) return;
  const fileName = path.basename(publicPath);
  if (requiredPrefix && !fileName.startsWith(requiredPrefix)) return;
  await unlink(path.join(UPLOAD_DIRS[folder], fileName)).catch(() => undefined);
}

/** Borra un archivo por su ruta absoluta (limpieza tras un error). Ignora si no existe. */
export async function removeAbsoluteFile(absolutePath: string | null): Promise<void> {
  if (absolutePath) await unlink(absolutePath).catch(() => undefined);
}
