import assert from 'node:assert/strict';
import test from 'node:test';

import * as runtime from '../index.mjs';
import { requiredImportsWasm } from './fixtures/required-imports.mjs';

const requiredNapi = [
  'napi_get_last_error_info',
  'napi_get_uv_event_loop',
  'napi_async_destroy',
  'napi_close_callback_scope',
  'napi_async_init',
  'napi_open_callback_scope',
  'napi_is_arraybuffer'
];

const requiredNodeEnv = [
  'uv_async_init',
  'uv_unref',
  'uv_close',
  'uv_poll_init_socket',
  'uv_timer_init',
  'uv_poll_stop',
  'uv_timer_stop',
  'uv_poll_start',
  'uv_async_send',
  'uv_queue_work',
  'uv_idle_start',
  'uv_check_start',
  'uv_timer_start',
  'uv_check_init',
  'uv_idle_init',
  'getnameinfo',
  'pthread_setschedparam',
  'sodium_init',
  'getaddrinfo',
  'crypto_box_easy_afternm',
  'crypto_box_open_easy_afternm',
  'crypto_box_keypair',
  'sodium_allocarray',
  'randombytes',
  'crypto_secretbox',
  'crypto_box',
  'sodium_free',
  'crypto_box_afternm',
  'crypto_box_open',
  'crypto_secretbox_open',
  'crypto_box_beforenm',
  'crypto_box_open_afternm',
  'emscripten_notify_memory_growth',
  '__syscall_rmdir',
  '__syscall_unlinkat',
  '__syscall_accept4',
  '__syscall_bind',
  '__syscall_connect',
  '__syscall_getpeername',
  '__syscall_getsockname',
  '__syscall_getsockopt',
  '__syscall_listen',
  '__syscall_recvfrom',
  '__syscall_sendto',
  '__syscall_setsockopt',
  '__syscall_socket'
];

test('loads the real N-API import fixture and implements required runtime calls', async () => {
  for (const name of requiredNapi) {
    assert.equal(typeof runtime.napi[name], 'function', `${name} must be callable`);
  }

  const nodeEnv = runtime.createNodeEnv();
  const { instance } = await WebAssembly.instantiate(requiredImportsWasm, {
    napi: runtime.napi,
    env: nodeEnv
  });
  nodeEnv.bind(instance);

  const environment = new runtime.Environment(instance);
  const result = 32;

  try {
    environment.pushScope();
    const arrayBuffer = environment.pushValue(new ArrayBuffer(8));
    const object = environment.pushValue({});

    assert.equal(instance.exports.probe(environment.id, arrayBuffer, result), 0);
    assert.equal(environment.memory[result], 1);
    assert.equal(instance.exports.probe(environment.id, object, result), 0);
    assert.equal(environment.memory[result], 0);

    assert.equal(instance.exports.exercise_napi(environment.id, arrayBuffer, result), 0);
    assert.equal(environment.memory[result], 1);
    assert.equal(environment.u32[36 >> 2], 0, 'uv loop output must be null');

    assert.equal(instance.exports.probe_last_error(environment.id, result), 0);
    const lastErrorInfo = environment.u32[result >> 2];
    assert.ok(lastErrorInfo > 0);
    assert.equal(environment.u32[(lastErrorInfo + 12) >> 2], 9);
    const errorMessage = environment.getString(environment.u32[lastErrorInfo >> 2]);
    assert.match(errorMessage, /uv_event_loop.*unsupported/i);

    assert.equal(runtime.napi.napi_get_last_error_info(9999, result), 1);
    assert.equal(runtime.napi.napi_get_uv_event_loop(9999, result), 1);
    assert.equal(runtime.napi.napi_async_destroy(9999, 1), 1);
    assert.equal(runtime.napi.napi_async_destroy(environment.id, 1), 1);
    assert.equal(runtime.napi.napi_async_init(9999, 0, 0, result), 1);
    assert.equal(runtime.napi.napi_open_callback_scope(9999, 0, 1, result), 1);
    assert.equal(runtime.napi.napi_close_callback_scope(9999, 1), 1);
    assert.equal(runtime.napi.napi_is_arraybuffer(9999, 1, result), 1);
  } finally {
    environment.destroy();
    nodeEnv.dispose();
  }
});

test('exposes the audited Node env imports and reports unsupported calls explicitly', () => {
  const nodeEnv = runtime.createNodeEnv();

  for (const name of requiredNodeEnv) {
    assert.equal(typeof nodeEnv[name], 'function', `env.${name} must be callable`);
  }

  assert.equal(typeof nodeEnv.unknown_import, 'function');
  assert.throws(() => nodeEnv.unknown_import(), /Unsupported WebAssembly import env\.unknown_import/);
  assert.throws(() => nodeEnv.sodium_init(), /Unsupported WebAssembly import env\.sodium_init/);
  assert.throws(() => nodeEnv.__syscall_socket(), /Unsupported WebAssembly import env\.__syscall_socket/);
});

test('runs real WASM env callbacks and cancels work on dispose and rebind', async () => {
  const nodeEnv = runtime.createNodeEnv();
  const { instance } = await WebAssembly.instantiate(requiredImportsWasm, {
    napi: runtime.napi,
    env: nodeEnv
  });
  nodeEnv.bind(instance);
  const environment = new runtime.Environment(instance);

  try {
    const memory = new Uint32Array(instance.exports.memory.buffer);
    assert.equal(instance.exports.exercise_env(96), 0);
    nodeEnv.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...memory.slice(16, 19)], [0, 0, 0]);

    nodeEnv.bind(instance);
    assert.equal(instance.exports.exercise_env(96), 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual([...memory.slice(16, 19)], [1, 1, 1]);
  } finally {
    environment.destroy();
    nodeEnv.dispose();
  }
});
