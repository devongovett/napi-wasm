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

  const { instance } = await WebAssembly.instantiate(requiredImportsWasm, {
    napi: runtime.napi,
    env: {}
  });

  const environment = new runtime.Environment(instance);
  const result = 32;
  environment.pushScope();
  const arrayBuffer = environment.pushValue(new ArrayBuffer(8));
  const object = environment.pushValue({});

  assert.equal(instance.exports.probe(environment.id, arrayBuffer, result), 0);
  assert.equal(environment.memory[result], 1);
  assert.equal(instance.exports.probe(environment.id, object, result), 0);
  assert.equal(environment.memory[result], 0);

  assert.equal(runtime.napi.napi_get_last_error_info(environment.id, result), 0);
  const lastErrorInfo = environment.u32[result >> 2];
  assert.ok(lastErrorInfo > 0);
  assert.equal(runtime.napi.napi_get_last_error_info(environment.id, result), 0);
  assert.equal(environment.u32[result >> 2], lastErrorInfo);

  assert.equal(runtime.napi.napi_get_uv_event_loop(environment.id, result), 0);
  assert.ok(environment.u32[result >> 2] > 0);

  assert.equal(runtime.napi.napi_async_init(environment.id, 0, 0, result), 0);
  const asyncContext = environment.u32[result >> 2];
  assert.ok(asyncContext > 0);
  assert.equal(runtime.napi.napi_open_callback_scope(environment.id, 0, asyncContext, result), 0);
  const callbackScope = environment.u32[result >> 2];
  assert.ok(callbackScope > 0);
  assert.equal(runtime.napi.napi_close_callback_scope(environment.id, callbackScope), 0);
  assert.equal(runtime.napi.napi_async_destroy(environment.id, asyncContext), 0);
});

test('exposes the audited Node env imports and reports unsupported calls explicitly', () => {
  const nodeEnv = runtime.createNodeEnv();

  for (const name of requiredNodeEnv) {
    assert.equal(typeof nodeEnv[name], 'function', `env.${name} must be callable`);
  }

  assert.throws(() => nodeEnv.sodium_init(), /Unsupported WebAssembly import env\.sodium_init/);
  assert.throws(() => nodeEnv.__syscall_socket(), /Unsupported WebAssembly import env\.__syscall_socket/);
});

test('schedules an async callback through the bound indirect function table', async () => {
  const calls = [];
  const instance = {
    exports: {
      __indirect_function_table: {
        get(index) {
          assert.equal(index, 3);
          return (...args) => calls.push(args);
        }
      }
    }
  };
  const nodeEnv = runtime.createNodeEnv(instance);

  assert.equal(nodeEnv.uv_async_init(0, 64, 3), 0);
  assert.equal(nodeEnv.uv_async_send(64), 0);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [[64]]);
  nodeEnv.dispose();
});
