import { describe, expect, it } from 'vitest'
import type { DesktopLinuxHost } from '../src/linux-host.ts'
import { planDesktopLinuxLaunch, resolveHardwareAcceleration, resolveOzoneSwitch } from '../src/linux-launch.ts'

/** A host that needs no degradation. */
const HEALTHY: DesktopLinuxHost = {
  gpu: { softwareOnly: false },
  sandbox: { sandboxAvailable: true },
  display: { waylandAvailable: false, x11Available: true },
}

describe('hardware acceleration override', () => {
  it.each([[undefined, undefined], ['', undefined], ['1', true], ['0', false]] as const)(
    'maps %s to %s', (value, expected) => {
      expect(resolveHardwareAcceleration(value === undefined ? {} : { DSH_DESKTOP_HARDWARE_ACCELERATION: value })).toBe(expected)
    })

  it.each(['true', 'yes', '2', ' 1', 'false'])('rejects %s instead of silently picking a path', (value) => {
    expect(() => resolveHardwareAcceleration({ DSH_DESKTOP_HARDWARE_ACCELERATION: value }))
      .toThrow('DSH_DESKTOP_HARDWARE_ACCELERATION must be 1 or 0')
  })
})

describe('Ozone backend selection', () => {
  it('prefers X11 whenever its socket answers, even beside a Wayland compositor', () => {
    // The Wayland backend segfaults on these hosts (no usable EGL), and their Wayland
    // sessions publish an Xwayland socket, so an answering X server is the survivable path.
    expect(resolveOzoneSwitch({ waylandAvailable: true, x11Available: true })).toEqual(['ozone-platform', 'x11'])
    expect(resolveOzoneSwitch({ waylandAvailable: false, x11Available: true })).toEqual(['ozone-platform', 'x11'])
  })

  it('uses Wayland when it is the only backend that answers', () => {
    expect(resolveOzoneSwitch({ waylandAvailable: true, x11Available: false })).toEqual(['ozone-platform', 'wayland'])
  })

  it('leaves the backend unset when neither socket answers', () => {
    // During the Xwayland race the shell must not force a backend it cannot reach.
    expect(resolveOzoneSwitch({ waylandAvailable: false, x11Available: false })).toBeUndefined()
  })
})

describe('Linux launch plan', () => {
  it('adds no degradation switch on a host that needs none', () => {
    // The shared-memory relocation is unconditional: it is harmless off the broken hosts and
    // there is no cheap measurement that predicts it.
    expect(planDesktopLinuxLaunch(HEALTHY, { hardwareAcceleration: undefined }))
      .toEqual({ switches: [['disable-dev-shm-usage'], ['ozone-platform', 'x11']], notices: [] })
  })

  it('disables the GPU process automatically on the measured hisi-drm host', () => {
    // The override is absent, so the measurement decides: no retry loop on every launch.
    const plan = planDesktopLinuxLaunch({
      ...HEALTHY, gpu: { softwareOnly: true, unsupportedDriver: 'hisi-drm' },
    }, { hardwareAcceleration: undefined })
    expect(plan.switches).toContainEqual(['disable-gpu'])
    expect(plan.notices).toEqual([])
  })

  it('keeps hardware acceleration when the override opts in despite the measurement', () => {
    const plan = planDesktopLinuxLaunch({ ...HEALTHY, gpu: { softwareOnly: true } }, { hardwareAcceleration: true })
    expect(plan.switches).not.toContainEqual(['disable-gpu'])
  })

  it('forces software rendering when the override opts out on a healthy GPU', () => {
    expect(planDesktopLinuxLaunch(HEALTHY, { hardwareAcceleration: false }).switches)
      .toContainEqual(['disable-gpu'])
  })

  it('disables the Chromium sandbox and reports it once it is unavailable', () => {
    const plan = planDesktopLinuxLaunch({
      ...HEALTHY, sandbox: { sandboxAvailable: false, unavailableReason: 'helper-not-setuid' },
    }, { hardwareAcceleration: undefined })
    expect(plan.switches).toContainEqual(['no-sandbox'])
    expect(plan.notices).toEqual(['sandbox-unavailable'])
  })

  it('reports no sandbox notice when the helper confines renderers', () => {
    expect(planDesktopLinuxLaunch(HEALTHY, { hardwareAcceleration: undefined }).notices).toEqual([])
  })

  it('combines every measured degradation on the reported UOS host', () => {
    const plan = planDesktopLinuxLaunch({
      gpu: { softwareOnly: true, unsupportedDriver: 'hisi-drm' },
      sandbox: { sandboxAvailable: false, unavailableReason: 'helper-not-setuid' },
      display: { waylandAvailable: true, x11Available: true },
    }, { hardwareAcceleration: undefined })
    expect(plan.switches).toEqual([
      ['disable-gpu'], ['no-sandbox'], ['disable-gpu-sandbox'], ['disable-dev-shm-usage'],
      ['ozone-platform', 'x11'],
    ])
    expect(plan.notices).toEqual(['sandbox-unavailable'])
  })

  it('never emits the same switch twice', () => {
    const plan = planDesktopLinuxLaunch({
      ...HEALTHY, gpu: { softwareOnly: true }, sandbox: { sandboxAvailable: false, unavailableReason: 'helper-missing' },
    }, { hardwareAcceleration: undefined })
    const names = plan.switches.map(([name]) => name)
    expect(new Set(names).size).toBe(names.length)
  })
})
