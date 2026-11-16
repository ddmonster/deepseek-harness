/**
 * Linux host capabilities that decide Desktop launch switches.
 *
 * The Electron 44 host scan recorded three environment defects that a Linux shell
 * cannot fix from the application layer: the GPU userland stack is broken on
 * hisi-drm hosts, the Chromium sandbox helper is not installed setuid, and a Wayland
 * session's `DISPLAY=:0` only works once Xwayland has published its socket. This
 * module measures those facts; `linux-launch.ts` turns them into switches.
 */
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Kernel DRM driver names whose userland has no usable Mesa DRI driver with this Electron build. */
const GPU_UNUSABLE_DRM_DRIVERS = ['hisi-drm'] as const

/** GPU facts that decide whether the Chromium GPU process is worth starting. */
export interface DesktopGpuCapability {
  /** Whether the host should run without the Chromium GPU process. */
  readonly softwareOnly: boolean
  /** DRM driver name that forced software rendering, when one was found. */
  readonly unsupportedDriver?: string
}

/** Sandbox facts that decide whether Chromium's setuid helper can confine renderers. */
export interface DesktopSandboxCapability {
  /** Whether the Chromium sandbox helper is present, root-owned, and setuid. */
  readonly sandboxAvailable: boolean
  /** Why the helper cannot confine renderers, when it cannot. */
  readonly unavailableReason?: 'helper-missing' | 'helper-not-setuid' | 'kernel-userns-disabled'
}

/** Display-session facts that decide which Ozone backend can present a window. */
export interface DesktopDisplayCapability {
  /** Whether a Wayland compositor answered on `WAYLAND_DISPLAY`. */
  readonly waylandAvailable: boolean
  /** Whether an X server already answers on `DISPLAY`. */
  readonly x11Available: boolean
}

/** Everything the launch planner needs to choose switches on this host. */
export interface DesktopLinuxHost {
  readonly gpu: DesktopGpuCapability
  readonly sandbox: DesktopSandboxCapability
  readonly display: DesktopDisplayCapability
}

/** Filesystem and process facts the measurement reads, injectable for tests. */
export interface DesktopLinuxProbeOptions {
  readonly env: NodeJS.ProcessEnv
  readonly statPath: (path: string) => Promise<{ uid: number; mode: number }>
  readonly readTextFile: (path: string) => Promise<string>
  /** Resolve a symlink to its target path; the DRM driver link needs the target's name. */
  readonly readLink: (path: string) => Promise<string>
  readonly listDirectory: (path: string) => Promise<string[]>
  /** Socket path test; a `true` answer means the X server already answers. */
  readonly isSocket: (path: string) => Promise<boolean>
  readonly runningUid: number
}

/**
 * Build the default probe from the real process environment and filesystem.
 * @returns Options that read this process's user, mounts, and session variables.
 */
export function defaultLinuxProbeOptions(): DesktopLinuxProbeOptions {
  return {
    env: process.env,
    statPath: async (path) => {
      const { stat } = await import('node:fs/promises')
      const value = await stat(path)
      return { uid: value.uid, mode: value.mode }
    },
    readTextFile: path => readFile(path, 'utf8'),
    readLink: path => readlink(path),
    listDirectory: path => readdir(path),
    isSocket: async (path) => {
      const { stat } = await import('node:fs/promises')
      return (await stat(path)).isSocket()
    },
    runningUid: process.getuid?.() ?? -1,
  }
}

/**
 * Read the kernel driver bound to one `/dev/dri` node.
 *
 * The node's device driver entry is a symlink into a bus driver directory, so the resolved
 * path's last segment names the driver. There is no driver link below the node's
 * own drm directory: the DRM class device is the parent of the card node, not a child.
 * @param options - Probe inputs.
 * @param node - DRM node name such as `card0` or `renderD128`.
 * @returns Driver name, or undefined when the node has no bound driver.
 */
async function readDrmDriver(options: DesktopLinuxProbeOptions, node: string): Promise<string | undefined> {
  const link = await options.readLink(join('/sys/class/drm', node, 'device', 'driver')).catch(() => undefined)
  return link?.trim().split('/').at(-1)
}

/**
 * Decide whether the GPU process can initialize.
 *
 * A DRM node is only usable when its kernel driver has a Mesa DRI driver that the
 * bundled userland can load. The scan established that hisi-drm has none, and that
 * the Mali userland on those hosts links against a kernel interface the fake
 * `/dev/mali0` node does not provide.
 * @param options - Probe inputs.
 * @returns Software-only decision and the driver that forced it.
 */
export async function measureDesktopGpu(options: DesktopLinuxProbeOptions): Promise<DesktopGpuCapability> {
  const nodes = await options.listDirectory('/dev/dri').catch(() => [])
  const drivers = (await Promise.all(nodes
    .filter(node => node.startsWith('card') || node.startsWith('renderD'))
    .map(node => readDrmDriver(options, node))))
    .filter(driver => driver !== undefined)
  const unsupported = drivers.find(driver => GPU_UNUSABLE_DRM_DRIVERS.includes(driver as typeof GPU_UNUSABLE_DRM_DRIVERS[number]))
  if (unsupported !== undefined) return { softwareOnly: true, unsupportedDriver: unsupported }
  // No DRM node at all means no GPU process can succeed either, but there is no driver to name.
  if (drivers.length === 0) return { softwareOnly: true }
  return { softwareOnly: false }
}

/**
 * Decide whether Chromium can confine renderers with its setuid helper.
 * @param options - Probe inputs, including the packaged helper path.
 * @param helperPath - Absolute path to the bundled `chrome-sandbox`.
 * @returns Availability and the first reason that prevented it.
 */
export async function measureDesktopSandbox(
  options: DesktopLinuxProbeOptions,
  helperPath: string,
): Promise<DesktopSandboxCapability> {
  const statistics = await options.statPath(helperPath).catch(() => undefined)
  if (statistics === undefined) return { sandboxAvailable: false, unavailableReason: 'helper-missing' }
  // Chromium requires the helper to be root-owned AND setuid; either alone is not confinement.
  const setuid = (statistics.mode & 0o4000) !== 0
  if (statistics.uid !== 0 || !setuid) {
    return { sandboxAvailable: false, unavailableReason: 'helper-not-setuid' }
  }
  const clone = await options.readTextFile('/proc/sys/kernel/unprivileged_userns_clone').catch(() => undefined)
  if (clone !== undefined && clone.trim() === '0') {
    return { sandboxAvailable: false, unavailableReason: 'kernel-userns-disabled' }
  }
  return { sandboxAvailable: true }
}

/** Read the X server socket that `DISPLAY` names. */
function displaySocketPath(env: NodeJS.ProcessEnv): string | undefined {
  // Only local displays have a socket; a host-qualified DISPLAY is served elsewhere.
  const match = /^(?:unix)?:(?<number>\d+)(?:\.\d+)?$/u.exec(env.DISPLAY ?? '')
  const number = match?.groups?.number
  return number === undefined ? undefined : `/tmp/.X11-unix/X${number}`
}

/**
 * Decide which presentation backend a window can use right now.
 *
 * A Wayland session usually also exports `DISPLAY=:0` through Xwayland, but that
 * socket only exists once Xwayland has started. Reporting X11 as available means the
 * socket answers now, not that the variable is set.
 * @param options - Probe inputs.
 * @returns Backend availability at measurement time.
 */
export async function measureDesktopDisplay(options: DesktopLinuxProbeOptions): Promise<DesktopDisplayCapability> {
  const waylandSocket = options.env.WAYLAND_DISPLAY
  const waylandAvailable = waylandSocket !== undefined && waylandSocket !== ''
    && await options.isSocket(join(options.env.XDG_RUNTIME_DIR ?? `/run/user/${options.runningUid}`, waylandSocket)).catch(() => false)
  const socket = displaySocketPath(options.env)
  const x11Available = socket !== undefined && await options.isSocket(socket).catch(() => false)
  return { waylandAvailable, x11Available }
}

/**
 * Measure every Linux launch capability once, before the application becomes ready.
 * @param helperPath - Absolute path to the bundled `chrome-sandbox`.
 * @param options - Probe inputs; defaults to this process's real environment.
 * @returns GPU, sandbox, and display facts for the launch planner.
 */
export async function measureDesktopLinuxHost(
  helperPath: string,
  options: DesktopLinuxProbeOptions = defaultLinuxProbeOptions(),
): Promise<DesktopLinuxHost> {
  const [gpu, sandbox, display] = await Promise.all([
    measureDesktopGpu(options),
    measureDesktopSandbox(options, helperPath),
    measureDesktopDisplay(options),
  ])
  return { gpu, sandbox, display }
}
