# Agent Note: 桌面 Linux 启动降级

Status: implemented

[English](2026-10-26-desktop-linux-launch-degradation.md) | 中文

## Problem

对一台 UOS Desktop 20 Pro aarch64 机器所做的 Electron 44 主机扫描记录了三项缺陷，它们存在于主机环境而非壳层：GPU 用户态栈不可用、Chromium 的 setuid 沙箱助手未安装、Wayland 会话的 `DISPLAY=:0` 指向 Xwayland 从而与启动过程形成竞态。Electron 的默认行为假定这三者都正常。在这类主机上，它们会导致每次启动 GPU 进程都失败、沙箱助手无法隔离渲染进程时拒绝启动，以及 Chromium 在 Xwayland 发布套接字之前选择 X11 后端时窗口始终不出现。

壳层必须测量这些事实并有意识地降级，因为在这类主机上另一种选择的后果是应用完全无法启动。

## Decision

`linux-host.ts` 在应用进入 ready 之前从文件系统测量三项能力，`linux-launch.ts` 把它们转换为启动开关。`main.ts` 在启动路径上同步发起测量，并在 `app.whenReady()` 之前通过 `app.commandLine.appendSwitch` 追加开关，因为 Chromium 在进入 ready 的过程中读取开关。

**GPU。** `/dev/dri` 下某个节点的 `/sys/class/drm/<node>/device/drm/driver` 报出 `hisi-drm` 时强制软件渲染：该驱动在随包用户态中没有对应的 Mesa DRI 驱动，此类主机把 Mali 用户态链接到伪造的 `/dev/mali0` 节点并不提供的内核接口上。完全没有 DRM 节点同样强制软件渲染。仅报出受支持驱动的节点则保留硬件加速。

**沙箱。** 随包的 `chrome-sandbox` 只有在属主为 root、带 setuid 位、且内核允许非特权命名空间时才能隔离渲染进程。不能满足时，壳层以 `--no-sandbox` 启动，并在主窗口出现后弹出一次警告对话框，说明原因以及 `chown root:root` 加 `chmod 4755` 的修复方式。用户会被告知自己处于降级状态；应用仍然启动。

**呈现后端。** 当套接字有响应时 `WAYLAND_DISPLAY` 优先，因为在 Wayland 会话下另一种选择是一个只有在 Xwayland 启动后才可用的 `DISPLAY`。只有在 X11 套接字已有响应时才选择 X11。两个套接字都无响应时，壳层不设置后端，而不是强制一个它无法到达的后端。

`DSH_DESKTOP_HARDWARE_ACCELERATION=1|0` 可任意方向覆盖 GPU 测量结果。其他任何取值都是错误；测量失败会被报告，随后按无降级处理，因此探测自身的缺陷不会阻断一个本来可以正常工作的启动。

## Alternatives considered

**沙箱助手无法隔离渲染进程时拒绝启动。** `dsh-sandbox` 在没有可用后端时拒绝以未限制方式运行，对齐这条规则是更严格的选择。它落选的原因是：这正是该降级所针对的那类机器，拒绝启动会把一个可用但降级的应用变成没有应用，而渲染进程隔离的缺口在壳层介入之前就已经是主机的属性。折中之处在于用户会被告知，而不是被静默降级。

**用 `bwrap` 自托管沙箱，失败时才回退。** `bwrap` 在扫描过的主机上可用，并且比 `--no-sandbox` 能更严格地限制子进程。它落选的原因是：把 Electron 主进程包进 `bwrap` 并不会改变 Electron 自身的子进程和它的 setuid 助手；决定渲染进程隔离的开关仍然是 `--no-sandbox`，因此额外的机制买不到它表面上提供的那种隔离。

**优先 X11，只等待 Xwayland 套接字。** 这是主机扫描实际走过的路径。它落选的原因是：等待一个可能永远不出现的套接字会让 Wayland 原生会话失去原生后端，而报告本身的建议是在 `WAYLAND_DISPLAY` 存在时优先 Wayland。套接字检查为纯 X11 桌面保留了 X11 路径，在那里它是唯一后端。

**捆绑一份干净的 Mesa `libgbm.so.1` 并在加载时优先使用。** 扫描的复现确认，替换成符号集完整的 `libgbm` 可以恢复 Mesa 的加载能力。它不属于本决策：它改变的是打包内容而不是壳层在启动时的决策，而且在 DRM 驱动没有 Mesa 驱动的主机上，它并不能恢复硬件加速。

**硬编码平台列表而不是测量。** 直接点名 UOS 或那个具体驱动就无需探测。它落选的原因是：同一个内核驱动可能配有已修复的用户态，同一份用户态也可能位于不同的驱动之上；测量让修复后的主机无需改代码就回到快路径。

## Consequences

壳层在 Electron 默认行为会失败的主机上能够启动，并且不再重试一个无法初始化的 GPU 进程。代价是壳层现在会在启动时读取 `/dev/dri`、`/sys/class/drm`、`/proc/sys/kernel` 和 `/tmp/.X11-unix`；测量失败是被容忍并报告的，但这确实是在启动路径上新增的文件系统接触面。

在受影响的主机上，沙箱警告每次启动显示一次，这是用户可见的打扰，直到该机上的助手被修复为止。在该状态下渲染进程仍未被隔离；对话框说明修复方式，而不是假装隔离已经存在。

GPU 测量只覆盖内核驱动。在驱动没有 Mesa 驱动的主机上，即使 `libgbm` 已修复，最终仍然走软件渲染，因此该计划会比 Chromium 自身的重试更早地关闭 GPU 进程。

`linux-arm64` 是一个打包目标（`package:linux:arm64`），不是发布目标：`retain-desktop-ci.ts` 拒绝它，因为保留清单 schema 没有 Linux target，`upload-target.ts` 也未列出它。因此 Linux 打包止步于本地 AppImage。

Linux target 产出 `AppImage` 与 `tar.gz`。AppImage type 2 的加载器链接 `libz.so`，那是只有开发包才提供的无版本名，因此只有 `libz.so.1` 的主机（如 UOS）无法启动它；解包的 `tar.gz` 直接运行打包的 Electron，没有这一依赖。两者的 Chromium `chrome-sandbox` 都保持 755，因此在这类主机上首次运行出现沙箱提示是预期行为，直到助手被修复。

**gbm shim。** Electron 二进制在 ELF NEEDED 条目中列出 `libgbm.so.1`，因此加载器会在 `main()` 运行前绑定所有 `gbm_*` 引用。若宿主 `libgbm.so.1` 是 kbase 版 libmali，进程会在任何 Electron 开关生效前因符号查找失败而死掉，没有启动参数能阻止它，也没有启动期探测能拦截它。因此 `resources/linux-gbm` 随包提供导出被引用符号集的 shim 以及 `probe-gbm.sh`（报告宿主库是否导出全部 20 个符号）。`linux-gbm-shim.mjs` 在 `afterPack` 中运行：用构建主机的 `cc` 编译 shim，把 Electron 二进制改名为 `deepseek-harness-bin`，并写一个 `deepseek-harness` 启动器——仅在探测失败时预加载 shim，否则原样 exec 二进制。Linux 打包不设置 `electronFuses`：fuses 会就地改写可执行文件，否则会作用到启动器脚本上。

探测读取 `process.execPath` 旁的助手，而不是 `app.getAppPath()`：打包后的 AppImage 把 `chrome-sandbox` 放在可执行文件旁，而 `getAppPath()` 解析到 asar 内部。`@deepseek-ai/libreoffice-kit` 0.1.5 未声明 Linux 原生引擎包，因此 Linux 包中的 Office 转换解析不到引擎，打包后运行时 smoke 在 AppImage 写出后停在该失败上。

## Testing

`linux-host.spec.ts` 覆盖每一项测量包括其拒绝路径：setuid 但属主为普通用户的助手、属主为 root 但没有 setuid 位的助手、拒绝非特权命名空间的内核、`DISPLAY` 已设置但套接字无响应的 Xwayland 竞态，以及非本地的 `DISPLAY` 形式。`linux-launch.spec.ts` 覆盖覆盖变量、后端选择，以及在扫描过的主机上的组合计划。`main-startup.spec.ts` 固定了非 Linux 不追加任何开关、开关在第一个窗口之前应用、沙箱对话框仅在助手无法隔离渲染进程时出现，以及测量失败时仍以 Electron 默认值启动应用。
