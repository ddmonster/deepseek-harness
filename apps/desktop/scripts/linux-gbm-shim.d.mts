/**
 * Compile the shim for the build host's architecture and install the launcher.
 *
 * The Electron binary lists `libgbm.so.1` in its ELF NEEDED entries, so the dynamic loader
 * binds every `gbm_*` reference before `main()` runs. A host that symlinks `libgbm.so.1` to
 * a kbase libmali kills the process with a symbol lookup error before any Electron switch
 * applies, which no launch flag can prevent.
 * @param input Packaged application, its resources directory, and the source resources directory.
 * @returns Nothing; the launcher owns the executable name and the shim sits in the resources.
 */
export function installLinuxGbmShim(input: {
  readonly appOutDir: string
  readonly resourcesDir: string
  readonly resourcesSource: string
}): void
