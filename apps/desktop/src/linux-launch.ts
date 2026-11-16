/**
 * Turn measured Linux host facts into Chromium switches and user-visible notices.
 *
 * Switches are applied before `app.whenReady()`, so this planner is pure: it decides,
 * and the caller performs the side effects.
 */
import type { DesktopLinuxHost } from './linux-host.ts'

/** One Chromium switch the planner asks the caller to append. */
export type DesktopEntrySwitch = readonly [name: string, value?: string]

/** Degradations the shell accepted and must tell the user about. */
export type DesktopLaunchNotice = 'sandbox-unavailable'

/** Validated overrides for the automatic decisions. */
export interface DesktopLinuxLaunchEnv {
  /** `DSH_DESKTOP_HARDWARE_ACCELERATION=1|0`; absent keeps the measured decision. */
  readonly hardwareAcceleration: boolean | undefined
}

/** Switches plus the notices that explain accepted degradations. */
export interface DesktopLinuxLaunchPlan {
  readonly switches: readonly DesktopEntrySwitch[]
  readonly notices: readonly DesktopLaunchNotice[]
}

/**
 * Read the acceleration override.
 * @param env - Desktop process environment.
 * @returns The configured override, or undefined when the measurement decides.
 * @throws When the value is neither `0` nor `1`, so a typo cannot silently pick a path.
 */
export function resolveHardwareAcceleration(env: NodeJS.ProcessEnv): boolean | undefined {
  const value = env.DSH_DESKTOP_HARDWARE_ACCELERATION
  if (value === undefined || value === '') return undefined
  if (value === '1') return true
  if (value === '0') return false
  throw new Error('DSH_DESKTOP_HARDWARE_ACCELERATION must be 1 or 0')
}

/**
 * Choose the presentation backend.
 *
 * An answering X server wins because it is the path every measured host survives: the
 * Wayland backend exits with a segmentation fault on the UOS desktops this degradation
 * targets, and their Wayland sessions publish an Xwayland socket that X11 uses. A host
 * that answers only on Wayland still gets it rather than no backend at all.
 * @param display - Measured backend availability.
 * @returns The Ozone switch, or undefined when the host names neither backend.
 */
export function resolveOzoneSwitch(
  display: DesktopLinuxHost['display'],
): DesktopEntrySwitch | undefined {
  if (display.x11Available) return ['ozone-platform', 'x11']
  if (display.waylandAvailable) return ['ozone-platform', 'wayland']
  return undefined
}

/**
 * Plan the switches for one measured host.
 * @param host - Measured GPU, sandbox, and display facts.
 * @param env - Validated overrides; absent acceleration follows the measurement.
 * @returns Switches to append before readiness and notices to present after it.
 */
export function planDesktopLinuxLaunch(
  host: DesktopLinuxHost,
  env: DesktopLinuxLaunchEnv,
): DesktopLinuxLaunchPlan {
  const switches: DesktopEntrySwitch[] = []
  const notices: DesktopLaunchNotice[] = []
  const acceleration = env.hardwareAcceleration ?? !host.gpu.softwareOnly
  if (!acceleration) switches.push(['disable-gpu'])
  if (!host.sandbox.sandboxAvailable) {
    // Renderer confinement cannot start without the setuid helper, and the GPU sandbox
    // fails the same way, which costs the whole GPU process rather than one renderer.
    switches.push(['no-sandbox'], ['disable-gpu-sandbox'])
    notices.push('sandbox-unavailable')
  }
  // Hosts whose /dev/shm rejects Chromium's shared-memory mapping crash every renderer at
  // startup. The switch moves those mappings to the temp directory and is harmless elsewhere.
  switches.push(['disable-dev-shm-usage'])
  const ozone = resolveOzoneSwitch(host.display)
  if (ozone !== undefined) switches.push(ozone)
  return { switches, notices }
}
