(module
  ;; The binary fixture is generated from this import/export shape. It mirrors
  ;; the N-API entry points required by the current zeromq Emscripten addon.
  (import "napi" "napi_get_last_error_info" (func (param i32 i32) (result i32)))
  (import "napi" "napi_get_uv_event_loop" (func (param i32 i32) (result i32)))
  (import "napi" "napi_async_destroy" (func (param i32 i32) (result i32)))
  (import "napi" "napi_close_callback_scope" (func (param i32 i32) (result i32)))
  (import "napi" "napi_async_init" (func (param i32 i32 i32 i32) (result i32)))
  (import "napi" "napi_open_callback_scope" (func (param i32 i32 i32 i32) (result i32)))
  (import "napi" "napi_is_arraybuffer" (func (param i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (table (export "__indirect_function_table") 1 funcref)
  (func (export "napi_wasm_malloc") (param i32) (result i32)
    (i32.const 1024))
  (func (export "napi_register_wasm_v1") (param i32 i32))
  (func (export "probe") (param i32 i32 i32) (result i32)
    (call 6 (local.get 0) (local.get 1) (local.get 2)))
)
