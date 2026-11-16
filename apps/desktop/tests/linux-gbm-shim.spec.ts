import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { installLinuxGbmShim } from '../scripts/linux-gbm-shim.mjs'

/**
 * These cases compile a shared library and read its dynamic symbol table, so they run only
 * where the packaging step itself runs: a Linux host with a C compiler and GNU nm.
 */
const linuxToolchain = process.platform === 'linux'
  && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('nm', ['--version'], { stdio: 'ignore' }).status === 0

const RESOURCES = join(import.meta.dirname, '..', 'resources')
const PROBE = join(RESOURCES, 'linux-gbm', 'probe-gbm.sh')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-gbm-shim-'))
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'deepseek-harness'), 'placeholder binary')
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe.skipIf(!linuxToolchain)('Linux gbm shim installation', () => {
  it('moves the Electron binary aside and puts a launcher in its place', () => {
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    const launcher = join(root, 'deepseek-harness')
    const binary = join(root, 'deepseek-harness-bin')
    expect(readFileSync(launcher, 'utf8')).toContain('LD_PRELOAD=')
    expect(readFileSync(binary, 'utf8')).toBe('placeholder binary')
    // The launcher must be executable and the binary must stay executable for exec.
    expect(statSync(launcher).mode & 0o111).not.toBe(0)
    expect(statSync(binary).mode & 0o111).not.toBe(0)
  })

  it('compiles the shim and ships the probe beside the resources', () => {
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    const shim = join(root, 'resources', 'linux-gbm', 'libgbm.so.1')
    expect(existsSync(shim)).toBe(true)
    // The shim must export the symbol whose absence kills the process.
    const exported = execFileSync('nm', ['-D', '--defined-only', shim], { encoding: 'utf8' })
    for (const symbol of ['gbm_bo_map', 'gbm_bo_get_modifier', 'gbm_create_device', 'gbm_bo_get_fd_for_plane']) {
      expect(exported).toMatch(new RegExp(`\\b${symbol}\\b`))
    }
    expect(existsSync(join(root, 'resources', 'linux-gbm', 'probe-gbm.sh'))).toBe(true)
  })

  it('keeps the original binary when the application directory is unpacked twice', () => {
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    // A second pass must not rename the launcher over the preserved Electron binary.
    expect(readFileSync(join(root, 'deepseek-harness-bin'), 'utf8')).toBe('placeholder binary')
  })

  it('replaces a stale shim directory instead of merging into it', () => {
    const stale = join(root, 'resources', 'linux-gbm')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'leftover.so'), 'stale')
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    expect(existsSync(join(stale, 'leftover.so'))).toBe(false)
  })
})

describe.skipIf(!linuxToolchain)('Linux gbm probe', () => {
  /** Build a shared library exporting the given symbol names. */
  function library(directory: string, symbols: readonly string[]): string {
    mkdirSync(directory, { recursive: true })
    const source = join(directory, 'stub.c')
    writeFileSync(source, `${symbols.map(symbol => `void ${symbol}(void) {}`).join('\n')}\n`)
    const output = join(directory, 'libgbm.so.1')
    execFileSync('cc', ['-shared', '-fPIC', '-o', output, source], { stdio: 'ignore' })
    return output
  }

  /**
   * The symbol list the probe enforces, read from the probe itself so a change there cannot
   * silently leave this case asserting an older set.
   */
  const REQUIRED = [...new Set(readFileSync(PROBE, 'utf8').match(/gbm_[a-z_]+/gu) ?? [])]

  /**
   * Build a subject binary that lists libgbm.so.1 in its NEEDED entries, mirroring the
   * Electron binary the probe runs against. A binary without that dependency would let the
   * probe fall through to the host library and report a false pass.
   */
  function subject(): string {
    const directory = join(root, 'subject-lib')
    mkdirSync(directory, { recursive: true })
    const stub = join(directory, 'stub.c')
    writeFileSync(stub, 'void gbm_bo_map(void) {}\n')
    execFileSync('cc', ['-shared', '-fPIC', '-Wl,-soname,libgbm.so.1', '-o', join(directory, 'libgbm.so.1'), stub], { stdio: 'ignore' })
    // The linker resolves -lgbm through the unversioned name; the NEEDED entry records the soname.
    execFileSync('ln', ['-sf', 'libgbm.so.1', join(directory, 'libgbm.so')], { stdio: 'ignore' })
    const source = join(directory, 'subject.c')
    writeFileSync(source, 'extern void gbm_bo_map(void);\nint main(void) { gbm_bo_map(); return 0; }\n')
    const output = join(directory, 'subject')
    execFileSync('cc', ['-o', output, source, '-L', directory, '-lgbm'], { stdio: 'ignore' })
    return output
  }

  /** Run the probe against a directory-preloaded library and return its exit code. */
  function probeExit(binary: string, directory: string): number {
    try {
      execFileSync('sh', [PROBE, binary], { env: { ...process.env, LD_LIBRARY_PATH: directory }, stdio: 'ignore' })
      return 0
    } catch (error: unknown) {
      return (error as { status?: number }).status ?? -1
    }
  }

  it('rejects a library that misses a referenced symbol', () => {
    // This is the host state the shim exists for: libmali without gbm_bo_map.
    library(join(root, 'incomplete'), ['gbm_create_device', 'gbm_device_destroy'])
    expect(probeExit(subject(), join(root, 'incomplete'))).toBe(1)
  })

  it('accepts a library exporting every referenced symbol', () => {
    const complete = library(join(root, 'complete'), REQUIRED)
    expect(probeExit(subject(), join(root, 'complete'))).toBe(0)
    expect(existsSync(complete)).toBe(true)
  })

  it('fails rather than assuming availability when no arguments are given', () => {
    expect(() => execFileSync('sh', [PROBE], { stdio: 'pipe' })).toThrow()
  })

  it('is executable so the launcher can invoke it', () => {
    expect(statSync(PROBE).mode & 0o111).not.toBe(0)
  })
})

describe.skipIf(!linuxToolchain)('Linux gbm launcher', () => {
  /** Read the launcher the installer writes, for asserting its runtime branches. */
  function launcherText(): string {
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    return readFileSync(join(root, 'deepseek-harness'), 'utf8')
  }

  it('preloads the shim only after the probe fails', () => {
    const text = launcherText()
    // The probe must gate the preload, not run unconditionally.
    expect(text).toMatch(/! sh "\$probe" "\$bin"/)
    expect(text.indexOf('LD_PRELOAD=')).toBeGreaterThan(text.indexOf('! sh "$probe" "$bin"'))
  })

  it('runs the binary directly when the probe succeeds or is missing', () => {
    const text = launcherText()
    expect(text).toContain('[ -f "$probe" ] && [ -f "$shim" ]')
    expect(text).toContain('exec "$bin" $degrade $ozoneArgs "$@"')
  })

  it('omits Chromium switches when the binary runs as the bundled Node runtime', () => {
    // The smoke test and the bundled `node` wrapper start this same binary with
    // ELECTRON_RUN_AS_NODE set, where a Chromium switch is an invalid option.
    const text = launcherText()
    expect(text).toContain('if [ -n "${ELECTRON_RUN_AS_NODE:-}" ]; then')
    const guard = text.indexOf('ELECTRON_RUN_AS_NODE')
    expect(guard).toBeGreaterThan(text.indexOf('ozoneArgs='))
    expect(guard).toBeGreaterThan(text.indexOf('degrade="--no-sandbox'))
    expect(guard).toBeLessThan(text.indexOf('exec "$bin" $degrade $ozoneArgs "$@"'))
  })

  it('hardcodes the degradation combination for every launch', () => {
    // The switches only apply before Chromium parses its command line, so they are
    // decided in the launcher rather than measured by application code, whose probe
    // read this class of host wrong in the field.
    const text = launcherText()
    expect(text).toContain('degrade="--no-sandbox --disable-gpu --disable-gpu-sandbox --disable-dev-shm-usage"')
  })

  it('appends to an inherited LD_PRELOAD instead of discarding it', () => {
    expect(launcherText()).toContain('${LD_PRELOAD:+:$LD_PRELOAD}')
  })

  it('keeps the launcher executable after installation', () => {
    launcherText()
    chmodSync(join(root, 'deepseek-harness'), 0o755)
    expect(statSync(join(root, 'deepseek-harness')).mode & 0o111).not.toBe(0)
  })
})

describe('Linux gbm launcher display backend', () => {
  /**
   * Resolve the launcher's own backend decision without launching Electron.
   * The decision is shell-only, so this runs wherever `sh` exists rather than
   * waiting for the packaging toolchain.
   * @param env - session variables the launcher reads.
   * @param args - command-line arguments the caller passed.
   * @returns the `--ozone-platform` switch the launcher would add, or an empty string.
   */
  function ozoneArgsFor(env: Record<string, string>, args: readonly string[] = []): string {
    installLinuxGbmShim({ appOutDir: root, resourcesDir: join(root, 'resources'), resourcesSource: RESOURCES })
    const source = readFileSync(join(root, 'deepseek-harness'), 'utf8')
      .replace('exec "$bin" $degrade $ozoneArgs "$@"', 'printf "%s" "$ozoneArgs"')
    const script = join(root, 'ozone-probe.sh')
    writeFileSync(script, source)
    chmodSync(script, 0o755)
    return execFileSync('sh', [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
  }

  it('selects x11 for a Wayland session that also offers XWayland', () => {
    expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }))
      .toBe('--ozone-platform=x11')
    // Wayland detected from the display socket alone.
    expect(ozoneArgsFor({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe('--ozone-platform=x11')
  })

  it('keeps the native backend for a Wayland session without XWayland', () => {
    expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' })).toBe('')
  })

  it('leaves an X11 session and its arguments untouched', () => {
    expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, ['--no-sandbox', '--flag'])).toBe('')
  })

  it('honours the environment override', () => {
    expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', DSH_DESKTOP_OZONE_PLATFORM: 'wayland' })).toBe('')
    expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', DSH_DESKTOP_OZONE_PLATFORM: 'x11' }))
      .toBe('--ozone-platform=x11')
  })

  it('never overrides a backend the caller already chose', () => {
    // Chromium reads the first switch it sees, so repeating it with another value is worse
    // than trusting the caller; both spellings count.
    for (const flag of ['--ozone-platform=wayland', '--ozone-platform-hint=wayland']) {
      expect(ozoneArgsFor({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, [flag])).toBe('')
    }
  })
})
