import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as runtime from '../index.mjs';

const execFileAsync = promisify(execFile);

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
  'emscripten_asm_const_int',
  'emscripten_notify_memory_growth',
  'napi_wasm_schedule',
  'napi_wasm_cancel'
];

async function findWatCompiler() {
  const candidates = process.env.WAT_COMPILER
    ? [process.env.WAT_COMPILER]
    : ['wat2wasm', 'wasm-as'];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      // Try the next compiler so local WABT and Binaryen installations both work.
    }
  }

  throw new Error(
    'napi-wasm tests require a WAT compiler. Install wat2wasm (WABT), install wasm-as (Binaryen), or set WAT_COMPILER.'
  );
}

async function loadRequiredImportsWasm() {
  const compiler = await findWatCompiler();
  const fixturePath = fileURLToPath(new URL('./fixtures/required-imports.wat', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'napi-wasm-test-'));
  const outputPath = join(directory, 'required-imports.wasm');

  try {
    await execFileAsync(compiler, [fixturePath, '-o', outputPath]);
    return new Uint8Array(await readFile(outputPath));
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Failed to compile ${fixturePath}: ${detail}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const requiredImportsWasm = await loadRequiredImportsWasm();

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
    assert.equal(environment.u32[(lastErrorInfo + 12) >> 2], 0);
    const errorMessage = environment.getString(environment.u32[lastErrorInfo >> 2]);
    assert.equal(errorMessage, '');

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

test('clears the last N-API error after successful async and callback scopes', async () => {
  const nodeEnv = runtime.createNodeEnv();
  const { instance } = await WebAssembly.instantiate(requiredImportsWasm, {
    napi: runtime.napi,
    env: nodeEnv
  });
  nodeEnv.bind(instance);

  const environment = new runtime.Environment(instance);
  const result = 32;

  try {
    assert.equal(runtime.napi.napi_get_uv_event_loop(environment.id, result), 9);
    assert.equal(environment.lastError.status, 9);
    assert.match(environment.lastError.message, /uv_event_loop.*unsupported/i);

    assert.equal(runtime.napi.napi_async_init(environment.id, 0, 0, result), 0);
    const asyncContext = environment.u32[result >> 2];
    assert.equal(instance.exports.probe_last_error(environment.id, result), 0);
    let lastErrorInfo = environment.u32[result >> 2];
    assert.equal(environment.u32[(lastErrorInfo + 12) >> 2], 0);
    assert.equal(environment.getString(environment.u32[lastErrorInfo >> 2]), '');

    assert.equal(
      runtime.napi.napi_open_callback_scope(environment.id, 0, asyncContext, result),
      0
    );
    const callbackScope = environment.u32[result >> 2];
    assert.equal(instance.exports.probe_last_error(environment.id, result), 0);
    lastErrorInfo = environment.u32[result >> 2];
    assert.equal(environment.u32[(lastErrorInfo + 12) >> 2], 0);
    assert.equal(environment.getString(environment.u32[lastErrorInfo >> 2]), '');

    assert.equal(runtime.napi.napi_close_callback_scope(environment.id, callbackScope), 0);
    assert.equal(runtime.napi.napi_async_destroy(environment.id, asyncContext), 0);
  } finally {
    environment.destroy();
    nodeEnv.dispose();
  }
});

test('exposes the implemented Node env imports and reports unsupported calls explicitly', () => {
  const nodeEnv = runtime.createNodeEnv({
    unsupportedImports: ['addon_specific_import']
  });

  for (const name of requiredNodeEnv) {
    assert.equal(typeof nodeEnv[name], 'function', `env.${name} must be callable`);
  }

  assert.equal(typeof nodeEnv.unknown_import, 'function');
  assert.throws(() => nodeEnv.unknown_import(), /Unsupported WebAssembly import env\.unknown_import/);
  assert.equal(typeof nodeEnv.addon_specific_import, 'function');
  assert.throws(
    () => nodeEnv.addon_specific_import(),
    /Unsupported WebAssembly import env\.addon_specific_import/
  );
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

test('refs and unrefs cooperative worker timers', () => {
  const nodeEnv = runtime.createNodeEnv();
  const instance = { exports: {} };
  const handles = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = (...args) => {
    const handle = originalSetTimeout(...args);
    handles.push(handle);
    return handle;
  };

  try {
    nodeEnv.bind(instance);
    nodeEnv.napi_wasm_schedule(0, 1, 1000);
    assert.equal(handles.length, 1);
    assert.equal(handles[0].hasRef(), true);

    nodeEnv.unref();
    assert.equal(handles[0].hasRef(), false);
    nodeEnv.ref();
    assert.equal(handles[0].hasRef(), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    nodeEnv.dispose();
  }
});
