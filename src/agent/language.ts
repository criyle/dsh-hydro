/**
 * Language inference for local problem packages.
 *
 * Hydro submissions need a judge language id; local solutions are named by
 * extension, so the verifier derives the language the same way a human would.
 */

/** Extension (lowercase, with dot) to Hydro language id. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cpp': 'cc',
  '.cc': 'cc',
  '.cxx': 'cc',
  '.c': 'c',
  '.py': 'py',
  '.java': 'java',
  '.pas': 'pas',
  '.go': 'go',
  '.rs': 'rs',
  '.js': 'js',
  '.ts': 'ts',
  '.rb': 'rb',
  '.php': 'php',
  '.sh': 'sh',
}

/** Infer a Hydro language id from a file path, or `null` when unknown. */
export function inferLangFromPath(path: string): string | null {
  const index = path.lastIndexOf('.')
  if (index < 0) return null
  return LANGUAGE_BY_EXTENSION[path.slice(index).toLowerCase()] ?? null
}

/** Extensions the solution-dir reader is willing to pick up. */
