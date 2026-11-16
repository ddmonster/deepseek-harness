/** Startup variables required by native executables before model evaluation. */

/**
 * Environment a native child needs before any program code runs: executable search,
 * Windows system paths, sandbox temporary paths, and the loader preload list.
 *
 * `LD_PRELOAD` is a startup variable, not program context. A host whose system library
 * cannot satisfy the executable's symbol references is repaired by preloading a shim, and
 * the program worker is often the same Electron binary as the shell that set it. Dropping
 * the list therefore does not withhold anything from the program — it prevents the child
 * from starting at all. Such hosts lose every in-program call while the shell itself runs.
 *
 * Windows resolves this name case-insensitively through the same set, matching how its
 * loader reads `Pathext` and `SystemRoot`.
 */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  // Dynamic-loader preload list: applied while the loader resolves symbols, before `main`.
  'LD_PRELOAD',
])

/**
 * Clear inherited credentials while preserving native child-process startup paths.
 * @param state - Child process environment, replaced with an empty program-visible object.
 */
export function clearProgramEnvironment(state: { env: NodeJS.ProcessEnv }): void {
  for (const key of Object.keys(state.env)) {
    if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())) Reflect.deleteProperty(state.env, key)
  }
  state.env = Object.create(null) as NodeJS.ProcessEnv
}
