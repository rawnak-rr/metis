import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `untitled-${sha256(value).slice(0, 8)}`;
}

export function sanitizeFilename(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

const VAULT_ESCAPE_MESSAGE = "Resolved path is outside the configured study vault.";

export function safePath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Expected a path relative to the configured study vault.");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the configured study vault.");
  }
  return resolved;
}

export async function safeExistingPath(root: string, relativePath: string): Promise<string> {
  const resolved = safePath(root, relativePath);
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(path.resolve(root)),
    realpath(resolved),
  ]);
  if (!isWithin(canonicalRoot, canonicalPath)) {
    throw new Error(VAULT_ESCAPE_MESSAGE);
  }
  return canonicalPath;
}

export async function safeWritePath(root: string, relativePath: string): Promise<string> {
  const resolved = safePath(root, relativePath);
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(path.resolve(root)),
    realpath(path.dirname(resolved)),
  ]);
  if (!isWithin(canonicalRoot, canonicalParent)) {
    throw new Error(VAULT_ESCAPE_MESSAGE);
  }
  return path.join(canonicalParent, path.basename(resolved));
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
