/** Install the gbm shim and its launcher into a packaged Linux application. */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHIM_DIRECTORY = 'linux-gbm'
const EXECUTABLE = 'deepseek-harness'
const BINARY = 'deepseek-harness-bin'

/**
 * Shell fragment that puts the display backend in the shell's argv before Chromium starts.
 *
 * Chromium selects its Ozone backend before the main script runs, so the choice cannot be
 * made from application code. Under a Wayland session that also offers XWayland, Electron
 * picks Wayland by itself, and drivers whose EGL cannot initialise on that backend make the
 * process die with SIGSEGV before the first window (a libmali stack with no Mesa DRI driver
 * for the DRM device is the common case). Native X11 uses the same backend, so preferring it
 * costs nothing there; a Wayland session with no `DISPLAY` keeps the native backend.
 *
 * `DSH_DESKTOP_OZONE_PLATFORM` overrides the choice: `x11` forces it, `wayland` keeps the
 * native backend, and `auto` applies the default above. An `--ozone-platform` switch the
 * caller already passed always wins.
 */
const ozoneLauncherFragment = `ozoneArgs=
has_ozone=
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  case "\${arg%%=*}" in
    --ozone-platform|--ozone-platform-hint) has_ozone=1; break ;;
  esac
done
if [ -z "$has_ozone" ]; then
  case "\${DSH_DESKTOP_OZONE_PLATFORM:-}" in
    x11) ozoneArgs="--ozone-platform=x11" ;;
    wayland) ;;
    *)
      case "\${XDG_SESSION_TYPE:-}" in
        wayland|Wayland|WAYLAND) session=wayland ;;
        x11|X11) session=x11 ;;
        *) if [ -n "\${WAYLAND_DISPLAY:-}" ]; then session=wayland; else session=x11; fi ;;
      esac
      if [ "$session" = wayland ] && [ -n "\${DISPLAY:-}" ]; then
        ozoneArgs="--ozone-platform=x11"
      fi
      ;;
  esac
fi
`

/** Launcher written beside the binary; it preloads the shim only when the host cannot bind. */
const LAUNCHER = `#!/bin/sh
# Start the bundled Electron with the degradation combination every targeted Linux host
# needs, decided here in the launcher because these switches only take effect before
# Chromium parses its command line, which is earlier than any application code runs.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
probe="$here/resources/${SHIM_DIRECTORY}/probe-gbm.sh"
shim="$here/resources/${SHIM_DIRECTORY}/libgbm.so.1"
bin="$here/${BINARY}"
if [ -f "$probe" ] && [ -f "$shim" ] && ! sh "$probe" "$bin"; then
  echo "deepseek-harness: host libgbm is incomplete; using the bundled gbm shim" >&2
  LD_PRELOAD="$shim\${LD_PRELOAD:+:\$LD_PRELOAD}"
  export LD_PRELOAD
fi
# Unconditional degradation: the sandbox helper is not installed setuid on the targeted
# hosts (and the sandboxed namespace then hides /tmp from renderers entirely), the DRM
# userland cannot initialize GL, and Chromium's shared-memory fallback needs the temp
# directory. A host that can run accelerated can edit this file, which is plain shell.
degrade="--no-sandbox --disable-gpu --disable-gpu-sandbox --disable-dev-shm-usage"
${ozoneLauncherFragment}exec "$bin" $degrade $ozoneArgs "$@"
`

/**
 * Compile the shim for the build host's architecture and install the launcher.
 *
 * The Electron binary lists `libgbm.so.1` in its ELF NEEDED entries, so the dynamic loader
 * binds every `gbm_*` reference before `main()` runs. A host that symlinks `libgbm.so.1` to
 * a kbase libmali kills the process with a symbol lookup error before any Electron switch
 * applies, which no launch flag can prevent.
 * @param {{ appOutDir: string, resourcesDir: string, resourcesSource: string }} input Packaged application, its resources directory, and the source resources directory.
 * @returns {void}
 */
export function installLinuxGbmShim({ appOutDir, resourcesDir, resourcesSource }) {
  const target = join(resourcesDir, SHIM_DIRECTORY)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const shim = join(target, 'libgbm.so.1')
  execFileSync('cc', ['-shared', '-fPIC', '-O2', '-o', shim, join(resourcesSource, 'linux-gbm', 'gbm-shim.c')], { stdio: 'inherit' })
  chmodSync(shim, 0o644)

  const probe = join(target, 'probe-gbm.sh')
  copyFileSync(join(resourcesSource, 'linux-gbm', 'probe-gbm.sh'), probe)
  chmodSync(probe, 0o755)

  const launcherPath = join(appOutDir, EXECUTABLE)
  const binaryPath = join(appOutDir, BINARY)
  // The unpack step can run twice for one application directory; keep the original binary.
  if (!existsSync(binaryPath)) renameSync(launcherPath, binaryPath)
  chmodSync(binaryPath, 0o755)
  writeFileSync(launcherPath, LAUNCHER)
  chmodSync(launcherPath, 0o755)
}
