/*
 * gbm shim for hosts whose libgbm.so.1 cannot satisfy the Electron binary's symbols.
 *
 * The Electron binary lists libgbm.so.1 in its ELF NEEDED entries, so the dynamic loader
 * resolves every gbm_* reference before main() runs. On hosts that symlink libgbm.so.1 to
 * a kbase libmali, those references are missing and the process dies with a symbol lookup
 * error before any Electron switch can apply. This shim exports the full referenced set so
 * the process starts; real GL work still fails at the EGL layer, which the launch plan
 * already routes to software rendering.
 *
 * Preloaded only when the launcher's probe finds the host library incomplete.
 */
#include <stddef.h>
#include <stdint.h>

void *gbm_create_device(int fd) { (void)fd; return NULL; }
void gbm_device_destroy(void *d) { (void)d; }
int gbm_device_get_fd(void *d) { (void)d; return -1; }
int gbm_device_is_format_supported(void *d, uint32_t format, uint32_t usage)
{ (void)d; (void)format; (void)usage; return 0; }
const char *gbm_device_get_backend_name(void *d) { (void)d; return "dsh-shim"; }

void *gbm_bo_create(void *d, uint32_t w, uint32_t h, uint32_t format, uint32_t flags)
{ (void)d; (void)w; (void)h; (void)format; (void)flags; return NULL; }
void *gbm_bo_create_with_modifiers(void *d, uint32_t w, uint32_t h, uint32_t format,
                                   const uint64_t *modifiers, uint32_t count)
{ (void)d; (void)w; (void)h; (void)format; (void)modifiers; (void)count; return NULL; }
void *gbm_bo_import(void *d, uint32_t type, void *buffer, uint32_t usage)
{ (void)d; (void)type; (void)buffer; (void)usage; return NULL; }
void *gbm_bo_map(void *b, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                 uint32_t flags, uint32_t stride, void **addr, uint32_t *stride_x, uint32_t *stride_y)
{ (void)b; (void)x; (void)y; (void)w; (void)h; (void)flags; (void)stride;
  (void)addr; (void)stride_x; (void)stride_y; return NULL; }
void gbm_bo_unmap(void *b, void *map_data) { (void)b; (void)map_data; }
void gbm_bo_destroy(void *b) { (void)b; }
void *gbm_bo_get_device(void *b) { (void)b; return NULL; }
int gbm_bo_get_fd_for_plane(void *b, int plane) { (void)b; (void)plane; return -1; }
int gbm_bo_get_handle(void *b, void *handle) { (void)b; (void)handle; return -1; }
int gbm_bo_get_handle_for_plane(void *b, int plane, void *handle)
{ (void)b; (void)plane; (void)handle; return -1; }
uint32_t gbm_bo_get_height(void *b) { (void)b; return 0; }
uint64_t gbm_bo_get_modifier(void *b) { (void)b; return 0; }
uint32_t gbm_bo_get_offset(void *b, int plane) { (void)b; (void)plane; return 0; }
int gbm_bo_get_plane_count(void *b) { (void)b; return 0; }
uint32_t gbm_bo_get_stride_for_plane(void *b, int plane) { (void)b; (void)plane; return 0; }
uint32_t gbm_bo_get_width(void *b) { (void)b; return 0; }
uint32_t gbm_bo_get_bpp(void *b) { (void)b; return 32; }
