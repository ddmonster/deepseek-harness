import { describe, expect, it } from 'vitest'
import {
  measureDesktopDisplay,
  measureDesktopGpu,
  measureDesktopLinuxHost,
  measureDesktopSandbox,
  type DesktopLinuxProbeOptions,
} from '../src/linux-host.ts'

/** Build probe inputs from plain maps; every unlisted path rejects like a missing file. */
function probe(options: {
  env?: NodeJS.ProcessEnv
  drivers?: Readonly<Record<string, string>>
  helper?: { uid: number; mode: number } | undefined
  usernsClone?: string
  sockets?: readonly string[]
  runningUid?: number
} = {}): DesktopLinuxProbeOptions {
  const drivers = options.drivers ?? {}
  const sockets = new Set(options.sockets ?? [])
  return {
    env: options.env ?? {},
    runningUid: options.runningUid ?? 1000,
    statPath: async (path) => {
      if (path === '/opt/app/chrome-sandbox' && options.helper !== undefined) return options.helper
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    // The kernel exposes the bound driver as a symlink into /sys/bus/*/drivers/<name>.
    readLink: async (path) => {
      const node = /^\/sys\/class\/drm\/(?<node>[^/]+)\/device\/driver$/u.exec(path)?.groups?.node
      if (node !== undefined && drivers[node] !== undefined) return `/sys/bus/platform/drivers/${drivers[node]}`
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    readTextFile: async (path) => {
      if (path === '/proc/sys/kernel/unprivileged_userns_clone' && options.usernsClone !== undefined) return `${options.usernsClone}\n`
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    listDirectory: async (path) => {
      if (path !== '/dev/dri') throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return Object.keys(drivers)
    },
    isSocket: async (path: string) => sockets.has(path),
  }
}

const SETUID_HELPER = { uid: 0, mode: 0o104755 }

describe('desktop Linux GPU measurement', () => {
  it('forces software rendering when the only DRM driver is hisi-drm', async () => {
    expect(await measureDesktopGpu(probe({ drivers: { card0: 'hisi-drm', renderD128: 'hisi-drm' } })))
      .toEqual({ softwareOnly: true, unsupportedDriver: 'hisi-drm' })
  })

  it('forces software rendering when a usable driver shares the host with hisi-drm', async () => {
    // One unusable node is enough: Chromium picks it and the GPU process fails on every launch.
    expect(await measureDesktopGpu(probe({ drivers: { card0: 'hisi-drm', renderD128: 'virtio_gpu' } })))
      .toEqual({ softwareOnly: true, unsupportedDriver: 'hisi-drm' })
  })

  it('keeps hardware acceleration on a supported driver', async () => {
    expect(await measureDesktopGpu(probe({ drivers: { card0: 'amdgpu', renderD128: 'amdgpu' } })))
      .toEqual({ softwareOnly: false })
  })

  it('forces software rendering when no DRM node exists and names no driver', async () => {
    expect(await measureDesktopGpu(probe())).toEqual({ softwareOnly: true })
  })

  it('ignores directory entries that are not DRM nodes', async () => {
    expect(await measureDesktopGpu(probe({ drivers: { byPath: 'hisi-drm', '': 'hisi-drm' } })))
      .toEqual({ softwareOnly: true })
  })

  it('reads the node driver link, not a nonexistent drm child', async () => {
    // A real UOS host reports hisi-drm only at /sys/class/drm/card0/device/driver; the
    // card node has no /sys/class/drm/card0/device/drm/driver, so a probe reading that
    // path finds no driver and silently keeps hardware acceleration on.
    const requested: string[] = []
    const base = probe({ drivers: { card0: 'hisi-drm' } })
    const measured = await measureDesktopGpu({
      ...base,
      readLink: async (path) => { requested.push(path); return base.readLink(path) },
    })
    expect(measured).toEqual({ softwareOnly: true, unsupportedDriver: 'hisi-drm' })
    expect(requested).toContain('/sys/class/drm/card0/device/driver')
    expect(requested.some(path => path.endsWith('/device/drm/driver'))).toBe(false)
  })
})

describe('desktop Linux sandbox measurement', () => {
  it('accepts a root-owned setuid helper', async () => {
    expect(await measureDesktopSandbox(probe({ helper: SETUID_HELPER }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: true })
  })

  it('rejects a missing helper', async () => {
    expect(await measureDesktopSandbox(probe(), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: false, unavailableReason: 'helper-missing' })
  })

  it('rejects the unprivileged helper the host scan recorded (user-owned, no setuid)', async () => {
    expect(await measureDesktopSandbox(probe({ helper: { uid: 1000, mode: 0o100755 } }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: false, unavailableReason: 'helper-not-setuid' })
  })

  it('rejects a setuid helper owned by another user', async () => {
    // Chromium requires root ownership AND setuid; either alone does not confine renderers.
    expect(await measureDesktopSandbox(probe({ helper: { uid: 1000, mode: 0o104755 } }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: false, unavailableReason: 'helper-not-setuid' })
  })

  it('rejects a root-owned helper without the setuid bit', async () => {
    expect(await measureDesktopSandbox(probe({ helper: { uid: 0, mode: 0o100755 } }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: false, unavailableReason: 'helper-not-setuid' })
  })

  it('rejects a correctly installed helper when the kernel refuses unprivileged namespaces', async () => {
    expect(await measureDesktopSandbox(probe({ helper: SETUID_HELPER, usernsClone: '0' }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: false, unavailableReason: 'kernel-userns-disabled' })
  })

  it('accepts the helper when the kernel leaves the sysctl unset', async () => {
    // 4.19 and later omit the sysctl when cloning is compiled-in and permitted.
    expect(await measureDesktopSandbox(probe({ helper: SETUID_HELPER }), '/opt/app/chrome-sandbox'))
      .toEqual({ sandboxAvailable: true })
  })
})

describe('desktop Linux display measurement', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0' }

  it('reports both backends once the compositor and Xwayland answer', async () => {
    expect(await measureDesktopDisplay(probe({ env, sockets: ['/run/user/1000/wayland-0', '/tmp/.X11-unix/X0'] })))
      .toEqual({ waylandAvailable: true, x11Available: true })
  })

  it('reports the Xwayland race: DISPLAY is set but the socket does not answer yet', async () => {
    // This is the defect the host scan recorded; a set DISPLAY must never imply availability.
    expect(await measureDesktopDisplay(probe({ env, sockets: ['/run/user/1000/wayland-0'] })))
      .toEqual({ waylandAvailable: true, x11Available: false })
  })

  it('reports an X-only desktop without Wayland', async () => {
    expect(await measureDesktopDisplay(probe({ env: { DISPLAY: ':0' }, sockets: ['/tmp/.X11-unix/X0'] })))
      .toEqual({ waylandAvailable: false, x11Available: true })
  })

  it('derives the runtime directory from the running user when XDG_RUNTIME_DIR is unset', async () => {
    expect(await measureDesktopDisplay(probe({ env: { WAYLAND_DISPLAY: 'wayland-1' }, runningUid: 4242,
      sockets: ['/run/user/4242/wayland-1'] })))
      .toEqual({ waylandAvailable: true, x11Available: false })
  })

  it.each([undefined, '', 'remote:0', 'host:10.0', 'notadisplay'])('does not treat DISPLAY %s as a local socket', async (DISPLAY) => {
    const sockets = ['/tmp/.X11-unix/X0', '/tmp/.X11-unix/X10', '']
    expect(await measureDesktopDisplay(probe({ env: { DISPLAY }, sockets })))
      .toEqual({ waylandAvailable: false, x11Available: false })
  })

  it('reads display numbers above 9 from DISPLAY', async () => {
    expect(await measureDesktopDisplay(probe({ env: { DISPLAY: ':10' }, sockets: ['/tmp/.X11-unix/X10'] })))
      .toEqual({ waylandAvailable: false, x11Available: true })
  })
})

describe('desktop Linux host measurement', () => {
  it('measures all three capabilities together', async () => {
    const host = await measureDesktopLinuxHost('/opt/app/chrome-sandbox', probe({
      drivers: { card0: 'hisi-drm' }, helper: { uid: 1000, mode: 0o100755 },
      env: { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' },
      sockets: ['/run/user/1000/wayland-0'],
    }))
    expect(host).toEqual({
      gpu: { softwareOnly: true, unsupportedDriver: 'hisi-drm' },
      sandbox: { sandboxAvailable: false, unavailableReason: 'helper-not-setuid' },
      display: { waylandAvailable: true, x11Available: false },
    })
  })
})
