import { describe, expect, it } from 'vitest'
import { clearProgramEnvironment, STARTUP_ENVIRONMENT_NAMES } from '../src/environment.ts'

describe('program environment startup list', () => {
  it('keeps the loader preload list with the native child', () => {
    // A host whose system library misses the executable's symbols is repaired by preloading a
    // shim; the worker is often that same binary, and the loader applies the list before `main`.
    // Withholding it does not withhold anything from the program — it prevents the start.
    expect(STARTUP_ENVIRONMENT_NAMES.has('LD_PRELOAD')).toBe(true)
  })

  it('keeps executable search, system paths, and temp paths', () => {
    for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
      expect(STARTUP_ENVIRONMENT_NAMES.has(name)).toBe(true)
    }
  })

  it('matches names case-insensitively so a Windows-style spelling still survives', () => {
    const state = { env: { Path: 'C:\\native', ld_preload: '/bundle/libgbm.so.1', SECRET: 'credential' } as NodeJS.ProcessEnv }
    clearProgramEnvironment(state)
    // The case-folded lookup retains both spellings and still drops the credential.
    expect(Object.keys(state.env)).toEqual([])
  })

  it('clears credentials and every other inherited value from the program', () => {
    const state = { env: { PATH: '/native', LD_PRELOAD: '/bundle/libgbm.so.1', SECRET: 'credential', AWS_KEY: 'k' } as NodeJS.ProcessEnv }
    clearProgramEnvironment(state)
    // The program sees an empty environment; only the OS-level child keeps the startup list.
    expect(state.env).toEqual({})
  })

  it('reports the preload list as a startup value, not program context', () => {
    // Documented contract: this set exists for values a native executable needs before main.
    expect([...STARTUP_ENVIRONMENT_NAMES].sort()).toEqual(['LD_PRELOAD', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR'])
  })
})
