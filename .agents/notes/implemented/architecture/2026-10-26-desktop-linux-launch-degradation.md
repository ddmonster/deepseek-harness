# Agent Note: Desktop Linux launch degradation

Status: implemented

English | [中文](2026-10-26-desktop-linux-launch-degradation.zh.md)

## Problem

The Electron 44 host scan of a UOS Desktop 20 Pro aarch64 machine recorded three defects that live in the host environment, not the shell: the GPU userland stack is unusable, Chromium's setuid sandbox helper is not installed, and a Wayland session's `DISPLAY=:0` names Xwayland, which races startup. Electron's defaults assume all three are sound. On that class of host they produce a GPU process that fails on every launch, a startup refusal when the sandbox helper cannot confine renderers, and a window that never appears when Chromium picks the X11 backend before Xwayland publishes its socket.

The shell has to measure these facts and degrade deliberately, because the alternative on such a host is an application that does not start at all.

## Decision

`linux-host.ts` measures three capabilities from the filesystem before the app becomes ready, and `linux-launch.ts` turns them into switches. `main.ts` requests the measurement synchronously on the startup path and appends the switches through `app.commandLine.appendSwitch` before `app.whenReady()`, because Chromium reads its switches while becoming ready.

**GPU.** A `/dev/dri` node whose `/sys/class/drm/<node>/device/drm/driver` names `hisi-drm` forces software rendering: that driver has no Mesa DRI driver in the bundled userland, and those hosts link the Mali userland against a kernel interface the fake `/dev/mali0` node does not provide. No DRM node at all also forces software rendering. A host whose only nodes name a supported driver keeps hardware acceleration.

**Sandbox.** The bundled `chrome-sandbox` confines renderers only when it is root-owned and setuid, and when the kernel allows unprivileged namespaces. When it cannot, the shell starts with `--no-sandbox` and presents one warning dialog after the main window exists, naming the cause and the `chown root:root` plus `chmod 4755` repair. The user is told they are running degraded; the application still starts.

**Presentation backend.** `WAYLAND_DISPLAY` wins when its socket answers, because the alternative on a Wayland session is a `DISPLAY` that only works after Xwayland starts. X11 is selected only when its socket already answers. When neither socket answers the shell leaves the backend unset rather than forcing one it cannot reach.

`DSH_DESKTOP_HARDWARE_ACCELERATION=1|0` overrides the GPU measurement in either direction. Any other value is an error, and a failed measurement is reported and then treated as no degradation, so a probe defect cannot block a launch that would otherwise work.

## Alternatives considered

**Refuse to launch when the sandbox helper cannot confine renderers.** `dsh-sandbox` refuses to run unconfined when no backend is usable, and matching that rule would be the stricter choice. It lost because this is exactly the machine the degradation addresses: refusing to start turns a working-but-degraded application into no application, while the renderer isolation gap is already a property of the host before the shell touches it. The compromise is that the user is told, not silently downgraded.

**Self-host the sandbox with `bwrap` and fall back only when it fails.** `bwrap` works on the scanned host and would confine subprocesses more tightly than `--no-sandbox`. It lost because wrapping the Electron main process in `bwrap` leaves Electron's own child processes and its setuid helper unchanged; the switch that decides renderer confinement is still `--no-sandbox`, so the extra machinery would not buy the isolation it appears to.

**Prefer X11 and only wait for the Xwayland socket.** This is the path the host scan actually exercised. It lost because waiting on a socket that may never appear leaves Wayland-native sessions without a native backend, and the report's own recommendation is to prefer Wayland when `WAYLAND_DISPLAY` is present. The socket check keeps the X11 path for X-only desktops, where it is the only backend.

**Bundle a clean Mesa `libgbm.so.1` and prefer it at load time.** The scan's reproduction confirmed that substituting a `libgbm` with the full symbol set restores Mesa's ability to load. It is not part of this decision: it changes what the package ships rather than what the shell decides at launch, and it would not restore hardware acceleration on a host whose DRM driver has no Mesa driver.

**Hardcode a platform list instead of measuring.** Naming UOS, or the specific driver, would need no probe. It lost because the same kernel driver can ship with a repaired userland, and the same userland can sit on a different driver; the measurement keeps a repaired host on the fast path without a code change.

## Consequences

The shell starts on hosts where Electron's defaults fail, and no longer retries a GPU process that cannot initialize. The cost is that the shell now reads `/dev/dri`, `/sys/class/drm`, `/proc/sys/kernel`, and `/tmp/.X11-unix` at startup — a measurement that fails is tolerated and reported, but it is new filesystem surface in the startup path.

The sandbox warning is shown once per launch on an affected host, which is user-visible friction that stays until the helper is repaired on the machine. Renderers remain unconfined in that state; the dialog states the repair rather than pretending the isolation exists.

The GPU measurement covers the kernel driver only. A repaired `libgbm` on a host whose driver has no Mesa driver still ends in software rendering, so the plan disables the GPU process earlier than Chromium's own retry would discover the same outcome.

`linux-arm64` is a packaging target (`package:linux:arm64`), not a published one: `retain-desktop-ci.ts` rejects it because the retention manifest schema has no Linux target, and `upload-target.ts` does not list it. Linux packages therefore stop at a local AppImage.

The Linux target builds `AppImage` and `tar.gz`. The AppImage type-2 loader links `libz.so`, the unversioned name only a development package provides, so a host with only `libz.so.1` such as UOS cannot start it; the extracted `tar.gz` runs the bundled Electron directly and has no such dependency. Both carry Chromium's `chrome-sandbox` at mode 755, so the sandbox notice is the expected first-run behavior there until the helper is repaired.

**The gbm shim.** The Electron binary lists `libgbm.so.1` in its ELF NEEDED entries, so the loader binds every `gbm_*` reference before `main()` runs. A host whose `libgbm.so.1` is a kbase libmali dies with a symbol lookup error before any Electron switch can apply, which no launch flag prevents and no startup probe can intercept. `resources/linux-gbm` therefore ships a shim exporting the referenced symbol set plus `probe-gbm.sh`, which reports whether the host library exports all 20 symbols. `linux-gbm-shim.mjs` runs from `afterPack`, compiles the shim with the build host's `cc`, renames the Electron binary to `deepseek-harness-bin`, and writes a `deepseek-harness` launcher that preloads the shim only when the probe fails and otherwise execs the binary unchanged. Linux packaging sets no `electronFuses`: fuses rewrite the executable in place and would otherwise target the launcher script.

The probe reads the helper beside `process.execPath`, not `app.getAppPath()`: a packaged AppImage keeps `chrome-sandbox` beside the executable while `getAppPath()` resolves inside the asar. `@deepseek-ai/libreoffice-kit` 0.1.5 declares no Linux native engine package, so Office conversion in a Linux package resolves no engine and the packaged-runtime smoke stops on that failure after the AppImage is written.

## Testing

`linux-host.spec.ts` covers each measurement including its rejection paths: a user-owned setuid helper, a root-owned helper without setuid, a kernel that refuses unprivileged namespaces, the Xwayland race where `DISPLAY` is set but the socket does not answer, and non-local `DISPLAY` forms. `linux-launch.spec.ts` covers the override, backend selection, and the combined plan on the scanned host. `main-startup.spec.ts` pins that no switch is appended off Linux, that switches are applied before the first window, that the sandbox dialog appears only when the helper cannot confine renderers, and that a failed measurement still starts the application with Electron's defaults.
