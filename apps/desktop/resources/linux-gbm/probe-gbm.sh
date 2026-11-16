#!/bin/sh
# Report whether the host libgbm can satisfy the Electron binary's symbol references.
#
# Electron lists libgbm.so.1 in its NEEDED entries and binds every gbm_* symbol before
# main() runs, so an incomplete host library kills the process before any Electron switch
# can apply. Exit 0 means the host library is usable; exit 1 means the bundled shim is
# required.
app=$1
if [ -z "$app" ]; then
  echo "usage: probe-gbm.sh <electron-binary>" >&2
  exit 2
fi

lib=$(ldd "$app" 2>/dev/null | awk '/libgbm\.so\.1/ {print $3; exit}')
if [ -z "$lib" ] || [ ! -e "$lib" ]; then
  for candidate in /usr/lib/aarch64-linux-gnu/libgbm.so.1 /lib/aarch64-linux-gnu/libgbm.so.1; do
    if [ -e "$candidate" ]; then
      lib=$candidate
      break
    fi
  done
fi
[ -n "$lib" ] && [ -e "$lib" ] || exit 1

# Every symbol the Electron binary references must be exported by the host library.
for symbol in \
  gbm_bo_create gbm_bo_create_with_modifiers gbm_bo_destroy gbm_bo_get_device \
  gbm_bo_get_fd_for_plane gbm_bo_get_handle gbm_bo_get_handle_for_plane gbm_bo_get_height \
  gbm_bo_get_modifier gbm_bo_get_offset gbm_bo_get_plane_count gbm_bo_get_stride_for_plane \
  gbm_bo_get_width gbm_bo_import gbm_bo_map gbm_bo_unmap gbm_create_device \
  gbm_device_destroy gbm_device_get_fd gbm_device_is_format_supported; do
  nm -D --defined-only "$lib" 2>/dev/null | grep -qw "$symbol" || exit 1
done
exit 0
