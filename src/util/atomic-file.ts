/**
 * Small filesystem helpers used by the account store.
 *
 * Secrets live in private files, so every write must be atomic (never leave a
 * half-written JSON file) and every created secret file must carry `0600`.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Create a directory (and parents) readable only by the current user. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  // `mkdir` does not tighten an existing directory; do it explicitly.
  try {
    await chmod(path, 0o700)
  } catch {
    // Best effort: some filesystems (e.g. FAT) do not support chmod.
  }
}

/** True when the path exists and is a regular file. */
export async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * Write a file atomically with an explicit mode.
 *
 * A sibling temporary file is created with the final mode, written and fsynced,
 * then renamed over the destination. Readers therefore see either the old or
 * the new content, never a partial write, and the mode is never widened by the
 * rename.
 */
export async function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const directory = dirname(path)
  await ensurePrivateDir(directory)
  const temporary = join(directory, `.${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(temporary, 'w', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Read a UTF-8 file, returning `undefined` when it does not exist. */
export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read and parse JSON, returning `undefined` when the file does not exist. */
export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const text = await readFileIfExists(path)
  if (text === undefined || text.trim() === '') return undefined
  return JSON.parse(text) as T
}

/** Serialize JSON with a trailing newline (nice diffs and manual edits). */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Remove a file when it exists. */
export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true })
}
