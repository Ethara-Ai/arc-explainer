/**
 * Author: Claude Opus 4
 * Date: 2026-04-02
 * PURPOSE: Centralized environment helpers for server-side configuration.
 *          Eliminates duplicated PYTHON_BIN resolution logic across 14+ files.
 * SRP/DRY check: Pass — single responsibility: environment variable resolution.
 */

/**
 * Resolve the Python binary path from environment.
 *
 * Precedence: PYTHON_BIN → PYTHON3 → platform default
 */
export function getPythonBin(): string {
  return (
    process.env.PYTHON_BIN ??
    process.env.PYTHON3 ??
    (process.platform === "win32" ? "python" : "python3")
  );
}
