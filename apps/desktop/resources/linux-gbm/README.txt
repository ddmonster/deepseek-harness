gbm shim for hosts with an incomplete libgbm.so.1
================================================

Why this exists
---------------
The Electron binary lists libgbm.so.1 in its ELF NEEDED entries. The dynamic loader
resolves every gbm_* reference before main() runs, so a host whose libgbm.so.1 is a
kbase libmali (missing gbm_bo_map, gbm_bo_get_modifier, and others) kills the process
with "symbol lookup error" before any Electron command-line switch can take effect.
No launch flag prevents this; the failure happens below the application.

How it works
------------
- gbm-shim.c exports every gbm_* symbol the Electron binary references.
- probe-gbm.sh exits 0 when the host library exports all of them, 1 otherwise.
- The packaged launcher runs probe-gbm.sh at startup. Only when it exits non-zero is
  the shim preloaded via LD_PRELOAD. Healthy hosts load their own libgbm unchanged.

Limit
-----
The shim returns NULL/zero for every entry point. It exists so the process can start;
GPU work still fails at the EGL layer, which the launch plan already routes to
software rendering. This is not a working GPU implementation.
