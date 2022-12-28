const NAPI_OK = 0;
const NAPI_GENERIC_FAILURE = 9;
const NAPI_HANDLE_SCOPE_MISMATCH = 13;

const environments = [];

export class Environment {
  scopes = [];
  references = [];
  wrappedObjects = new WeakMap();
  externalObjects = new WeakMap();
  pendingException;

  constructor(instance) {
    this.id = environments.length;
    environments.push(this);

    this.instance = instance;
    this.table = instance.exports.__indirect_function_table;
    this.exports = {};

    this.pushScope();
    let values = this.scopes[this.scopes.length - 1];
    let exports = values.length;
    values.push(this.exports);

    try {
      this.instance.exports.napi_register_module_v1(this.id, exports);
      if (this.instance.exports.napi_register_wasm_v1) {
        this.instance.exports.napi_register_wasm_v1(this.id, exports);
      }
    } finally {
      this.popScope();
      if (this.pendingException) {
        let e = this.pendingException;
        this.pendingException = null;
        throw e;
      }
    }
  }

  destroy() {
    environments[this.id] = undefined;
  }

  getString(ptr, len = strlen(this.memory, ptr)) {
    return decoder.decode(this.memory.subarray(ptr, ptr + len));
  }

  pushScope() {
    let id = this.scopes.length;
    this.scopes.push([undefined, null, globalThis, true, false]);
    return id;
  }

  popScope() {
    this.scopes.pop();
  }

  get(idx) {
    return this.scopes[this.scopes.length - 1][idx];
  }

  set(idx, value) {
    this.scopes[this.scopes.length - 1][idx] = value;
  }

  pushValue(value) {
    let values = this.scopes[this.scopes.length - 1];
    let id = values.length;
    values.push(value);
    return id;
  }

  createValue(value, result) {
    if (typeof value === 'boolean') {
      this.setPointer(result, value ? 3 : 4);
      return NAPI_OK;
    } else if (typeof value === 'undefined') {
      this.setPointer(result, 0);
      return NAPI_OK;
    } else if (value === null) {
      this.setPointer(result, 1);
      return NAPI_OK;
    } else if (value === globalThis) {
      this.setPointer(result, 2);
      return NAPI_OK;
    }

    let id = this.pushValue(value);
    this.setPointer(result, id);
    return NAPI_OK;
  }

  setPointer(ptr, value) {
    this.u32[ptr >> 2] = value;
    return NAPI_OK;
  }

  _u32 = new Uint32Array();
  get u32() {
    if (this._u32.byteLength === 0) {
      this._u32 = new Uint32Array(this.instance.exports.memory.buffer);
    }

    return this._u32;
  }

  _i32 = new Int32Array();
  get i32() {
    if (this._i32.byteLength === 0) {
      this._i32 = new Int32Array(this.instance.exports.memory.buffer);
    }

    return this._i32;
  }

  _u64 = new BigUint64Array();
  get u64() {
    if (this._u64.byteLength === 0) {
      this._u64 = new BigUint64Array(this.instance.exports.memory.buffer);
    }

    return this._u64;
  }

  _i64 = new BigInt64Array();
  get i64() {
    if (this._i64.byteLength === 0) {
      this._i64 = new BigInt64Array(this.instance.exports.memory.buffer);
    }

    return this._i64;
  }

  _f64 = new Float64Array();
  get f64() {
    if (this._f64.byteLength === 0) {
      this._f64 = new Float64Array(this.instance.exports.memory.buffer);
    }

    return this._f64;
  }

  _buf = new Uint8Array();
  get memory() {
    if (this._buf.byteLength === 0) {
      this._buf = new Uint8Array(this.instance.exports.memory.buffer);
    }

    return this._buf;
  }

  createBuffer(data) {
    let ptr = this.instance.exports.wasm_malloc(data.byteLength);
    let mem = this.memory;
    mem.set(data, ptr);
    return new BufferValue(this, ptr, data.byteLength, null, null);
  }
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const latin1Decoder = new TextDecoder('latin1');
const utf16Decoder = new TextDecoder('utf-16');
const encoder = new TextEncoder();

class FinalizeRecord {
  constructor(env, finalize, hint, data) {
    this.env = env;
    this.finalize = finalize;
    this.hint = hint;
    this.data = data;
  }
}

const finalizationRegistry = new FinalizationRegistry(buffer => {
  if (buffer.finalize) {
    buffer.finalize(buffer.env, buffer.data, buffer.hint);
  }
});

class BufferValue {
  constructor(env, data, length, finalize, finalizeHint) {
    this.env = env;
    this.data = data;
    this.length = length;

    if (finalize) {
      finalizationRegistry.register(this, new FinalizeRecord(env.id, finalize, finalizeHint, data));
    }
  }

  get() {
    return this.env.memory.subarray(this.data, this.data + this.length);
  }

  toString() {
    return decoder.decode(this.get());
  }
}

class ExternalValue {}

const threadsafeFunctions = [];

class ThreadSafeFunction {
  constructor(env, fn, nativeFn, context) {
    this.env = env;
    this.fn = fn;
    this.nativeFn = nativeFn;
    this.context = context;
    this.id = threadsafeFunctions.length;
    threadsafeFunctions.push(this);
  }
}

export const napi = {
  napi_open_handle_scope(env_id, result) {
    let env = environments[env_id];
    let id = env.pushScope();
    return env.setPointer(result, id);
  },
  napi_close_handle_scope(env_id, scope) {
    let env = environments[env_id];
    if (scope !== env.scopes.length - 1) {
      return NAPI_HANDLE_SCOPE_MISMATCH;
    }
    env.popScope();
    return NAPI_OK;
  },
  napi_open_escapable_handle_scope(env_id, result) {
    throw new Error('not implemented');
  },
  napi_close_escapable_handle_scope(env_id, scope) {
    throw new Error('not implemented');
  },
  napi_escape_handle(env_id, scope, escapee, result) {
    throw new Error('not implemented');
  },
  napi_create_object(env_id, result) {
    let env = environments[env_id];
    return env.createValue({}, result);
  },
  napi_set_property(env_id, object, key, value) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.get(key);
    let val = env.get(value);
    obj[name] = val;
    return NAPI_OK;
  },
  napi_get_property(env_id, object, key, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.get(key);
    return env.createValue(obj[name], result);
  },
  napi_delete_property(env_id, object, key, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.get(key);
    let res = false;
    try {
      res = delete obj[name];
    } catch (err) {}
    if (result) {
      env.memory[result] = res ? 1 : 0;
    }
    return NAPI_OK;
  },
  napi_has_property(env_id, object, key, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.get(key);
    // return env.setPointer(result, name in obj ? 1 : 0);
    env.memory[result] = name in obj ? 1 : 0;
    return NAPI_OK;
  },
  napi_has_own_property(env_id, object, key, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.get(key);
    env.memory[result] = obj.hasOwnProperty(name) ? 1 : 0;
    return NAPI_OK;
  },
  napi_set_named_property(env_id, object, utf8Name, value) {
    let env = environments[env_id];
    let obj = env.get(object);
    let val = env.get(value);
    let name = env.getString(utf8Name);
    obj[name] = val;
    return NAPI_OK;
  },
  napi_get_named_property(env_id, object, utf8Name, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.getString(utf8Name);
    return env.createValue(obj[name], result);
  },
  napi_has_named_property(env_id, object, utf8Name, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let name = env.getString(utf8Name);
    env.memory[result] = name in obj ? 1 : 0;
    return NAPI_OK;
  },
  napi_get_property_names(env_id, object, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let properties = Object.keys(obj);
    return env.createValue(properties, result);
  },
  napi_get_all_property_names(env_id, object, key_mode, key_filter, key_conversion, result) {
    throw new Error('not implemented');
  },
  napi_define_properties(env_id, object, property_count, properties) {
    throw new Error('not implemented');
  },
  napi_object_freeze(env_id, object) {
    let env = environments[env_id];
    let obj = env.get(object);
    Object.freeze(obj);
    return NAPI_OK;
  },
  napi_object_seal(env_id, object) {
    let env = environments[env_id];
    let obj = env.get(object);
    Object.seal(obj);
    return NAPI_OK;
  },
  napi_get_prototype(env_id, object, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    return env.createValue(Object.getPrototypeOf(obj), result);
  },
  napi_define_class() {
    throw new Error('not implemented');
  },
  napi_create_reference(env_id, value, refcount, result) {
    let env = environments[env_id];
    let id = env.references.length;
    env.references.push({
      value: env.get(value),
      refcount
    });
    return env.setPointer(result, id);
  },
  napi_delete_reference(env_id, ref) {
    let env = environments[env_id];
    env.references[ref] = undefined;
    return NAPI_OK;
  },
  napi_get_reference_value(env_id, ref, result) {
    let env = environments[env_id];
    let reference = env.references[ref];
    return env.createValue(reference.value, result);
  },
  napi_reference_ref(env_id, ref, result) {
    let env = environments[env_id];
    let reference = env.references[ref];
    reference.refcount++;
    return env.setPointer(result, reference.refcount);
  },
  napi_reference_unref(env_id, ref, result) {
    let env = environments[env_id];
    let reference = env.references[ref];
    if (reference.refcount === 0) {
      return NAPI_GENERIC_FAILURE;
    }
    reference.refcount--;
    return env.setPointer(result, reference.refcount);
  },
  napi_add_env_cleanup_hook() {
    throw new Error('not implemented');
  },
  napi_remove_env_cleanup_hook() {
    throw new Error('not implemented');
  },
  napi_add_async_cleanup_hook() {
    throw new Error('not implemented');
  },
  napi_remove_async_cleanup_hook() {
    throw new Error('not implemented');
  },
  napi_set_instance_data() {
    throw new Error('not implemented');
  },
  napi_get_instance_data() {
    throw new Error('not implemented');
  },
  napi_get_boolean(env_id, value, result) {
    let env = environments[env_id];
    return env.setPointer(result, value ? 3 : 4);
  },
  napi_get_value_bool(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.memory[result] = val ? 1 : 0;
    return NAPI_OK;
  },
  napi_create_int32(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(value, result);
  },
  napi_get_value_int32(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.i32[result >> 2] = val;
    return NAPI_OK;
  },
  napi_create_uint32(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(value, result);
  },
  napi_get_value_uint32(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    return env.setPointer(result, val);
  },
  napi_create_int64(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(Number(value), result);
  },
  napi_get_value_int64(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.i64[result >> 3] = val;
    return NAPI_OK;
  },
  napi_create_double(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(value, result);
  },
  napi_get_value_double(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.f64[result >> 3] = val;
    return NAPI_OK;
  },
  napi_create_bigint_int64(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(BigInt.asIntN(64, value), result);
  },
  napi_get_value_bigint_int64(env_id, value, result, lossless) {
    let env = environments[env_id];
    let val = env.get(value);
    env.i64[result >> 3] = val;
    if (lossless) {
      env.memory[lossless] = BigInt.asIntN(64, val) === val ? 1 : 0;
    }
    return NAPI_OK;
  },
  napi_create_bigint_uint64(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(BigInt.asUintN(64, value), result);
  },
  napi_get_value_bigint_uint64(env_id, value, result, lossless) {
    let env = environments[env_id];
    let val = env.get(value);
    env.u64[result >> 3] = val;
    if (lossless) {
      env.memory[lossless] = BigInt.asUintN(64, val) === val ? 1 : 0;
    }
    return NAPI_OK;
  },
  napi_create_bigint_words(env_id, sign_bit, word_count, words, result) {
    throw new Error('not implemented');
  },
  napi_get_value_bigint_words() {

  },
  napi_get_null(env_id, result) {
    let env = environments[env_id];
    return env.setPointer(result, 1);
  },
  napi_create_array(env_id, result) {
    let env = environments[env_id];
    return env.createValue([], result);
  },
  napi_create_array_with_length(env_id, length, result) {
    let env = environments[env_id];
    return env.createValue(new Array(length), result);
  },
  napi_set_element(env_id, object, index, value) {
    let env = environments[env_id];
    let obj = env.get(object);
    let val = env.get(value);
    obj[index] = val;
    return NAPI_OK;
  },
  napi_get_element(env_id, object, index, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let val = obj[index];
    return env.createValue(val, result);
  },
  napi_has_element(env_id, object, index, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    env.memory[result] = obj.hasOwnProperty(index) ? 1 : 0;
    return NAPI_OK;
  },
  napi_delete_element(env_id, object, index, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let res = false;
    try {
      res = delete obj[name];
    } catch (err) {}
    if (result) {
      env.memory[result] = res ? 1 : 0;
    }
    return NAPI_OK;
  },
  napi_get_array_length(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    return env.setPointer(result, val.length);
  },
  napi_get_undefined(env_id, result) {
    let env = environments[env_id];
    return env.setPointer(result, 0);
  },
  napi_create_function(env_id, utf8name, length, cb, data, result) {
    let env = environments[env_id];
    let fn = env.table.get(cb);
    let func = function (...args) {
      let scope = env.pushScope();

      try {
        let values = env.scopes[scope];
        let info = values.length;
        values.push({
          thisArg: this,
          args,
          data,
          newTarget: new.target
        });

        let res = fn(env_id, info);
        return env.get(res);
      } finally {
        env.popScope();
        if (env.pendingException) {
          let e = env.pendingException;
          env.pendingException = null;
          throw e;
        }
      }
    };

    Object.defineProperty(func, 'name', {
      value: env.getString(utf8name, length),
      configurable: true
    });

    return env.createValue(func, result);
  },
  napi_call_function(env_id, recv, func, argc, argv, result) {
    let env = environments[env_id];
    let thisArg = env.get(recv);
    let fn = env.get(func);
    let args = new Array(argc);
    let mem = env.u32;
    for (let i = 0; i < argc; i++) {
      args[i] = env.get(mem[argv >> 2]);
      argv += 4;
    }

    let res = fn.apply(thisArg, args);
    return env.createValue(res, result);
  },
  napi_new_instance(env_id, cons, argc, argv, result) {
    let env = environments[env_id];
    let Class = env.get(cons);
    let args = new Array(argc);
    let mem = env.u32;
    for (let i = 0; i < argc; i++) {
      args[i] = env.get(mem[argv >> 2]);
      argv += 4;
    }

    let value = new Class(...args);
    return env.createValue(value, result);
  },
  napi_get_cb_info(env_id, cbinfo, argc, argv, thisArg, data) {
    let env = environments[env_id];
    let info = env.get(cbinfo);
    env.setPointer(argc, info.args.length);
    for (let i = 0; i < info.args.length; i++) {
      env.createValue(info.args[i], argv);
      argv += 4;
    }
    env.createValue(info.thisArg, thisArg);
    env.setPointer(data, info.data);
    return NAPI_OK;
  },
  napi_get_new_target(env_id, cbinfo, result) {
    let env = environments[env_id];
    let info = env.get(cbinfo);
    return env.createValue(info.newTarget, result);
  },
  napi_create_threadsafe_function(
    env_id,
    func,
    async_resource,
    async_resource_name,
    max_queue_size,
    initial_thread_count,
    thread_finalize_data,
    thread_finalize_cb,
    context,
    call_js_cb,
    result
  ) {
    let env = environments[env_id];
    let fn = func ? env.get(func) : undefined;
    let cb = call_js_cb ? env.table.get(call_js_cb) : undefined;
    let f = new ThreadSafeFunction(env, fn, cb, context);

    if (thread_finalize_cb) {
      let cb = env.table.get(thread_finalize_cb);
      finalizationRegistry.register(f, new FinalizeRecord(cb, 0, f.id));
    }

    env.setPointer(result, f.id);
    return NAPI_OK;
  },
  napi_ref_threadsafe_function() {
    return NAPI_OK;
  },
  napi_unref_threadsafe_function() {
    return NAPI_OK;
  },
  napi_acquire_threadsafe_function() {
    return NAPI_OK;
  },
  napi_release_threadsafe_function(func, mode) {
    threadsafeFunctions[func] = undefined;
    return NAPI_OK;
  },
  napi_call_threadsafe_function(func, data, is_blocking) {
    let f = threadsafeFunctions[func];
    f.env.pushScope();
    try {
      if (f.nativeFn) {
        let id = f.fn ? f.env.pushValue(f.fn) : 0;
        f.nativeFn(f.env.id, id, f.context, data);
      } else if (f.fn) {
        f.fn();
      }
    } finally {
      f.env.popScope();
    }
  },
  napi_get_threadsafe_function_context(func, result) {
    let f = threadsafeFunctions[func];
    f.env.setPointer(result, f.context);
    return NAPI_OK;
  },
  napi_throw(env_id, error) {
    let env = environments[env_id];
    env.pendingException = env.get(error);
    return NAPI_OK;
  },
  napi_throw_error(env_id, code, msg) {
    let env = environments[env_id];
    let err = new Error(env.getString(msg));
    err.code = code;
    env.pendingException = err;
    return NAPI_OK;
  },
  napi_throw_type_error(env_id, code, msg) {
    let env = environments[env_id];
    let err = new TypeError(env.getString(msg));
    err.code = code;
    env.pendingException = err;
    return NAPI_OK;
  },
  napi_throw_range_error(env_id, code, msg) {
    let env = environments[env_id];
    let err = new RangeError(env.getString(msg));
    err.code = code;
    env.pendingException = err;
    return NAPI_OK;
  },
  napi_create_error(env_id, code, msg, result) {
    let env = environments[env_id];
    let err = new Error(env.get(msg));
    err.code = env.get(code);
    return env.createValue(err, result);
  },
  napi_create_type_error(env_id, code, msg, result) {
    let env = environments[env_id];
    let err = new TypeError(env.get(msg));
    err.code = env.get(code);
    return env.createValue(err, result);
  },
  napi_create_range_error(env_id, code, msg, result) {
    let env = environments[env_id];
    let err = new RangeError(env.get(msg));
    err.code = env.get(code);
    return env.createValue(err, result);
  },
  napi_get_and_clear_last_exception(env_id, result) {
    let env = environments[env_id];
    let e = env.pendingException;
    env.pendingException = null;
    return env.createValue(e, result);
  },
  napi_is_exception_pending(env_id, result) {
    let env = environments[env_id];
    env.memory[result] = env.pendingException ? 1 : 0;
    return NAPI_OK;
  },
  napi_fatal_exception(env_id, err) {
    throw new Error('not implemented');
  },
  napi_fatal_error(location, location_len, message, message_len) {
    throw new Error('not implemented');
  },
  napi_get_global(env_id, result) {
    let env = environments[env_id];
    return env.setPointer(result, 2);
  },
  napi_create_buffer(env_id, length, data, result) {
    let env = environments[env_id];
    return env.createValue(new BufferValue(env, data, length, null, null), result);
  },
  napi_create_buffer_copy(env_id, length, data, result_data, result) {
    let env = environments[env_id];
    let buf = env.createBuffer(env.memory.subarray(data, data + length));
    if (result_data) {
      env.setPointer(result_data, buf.data);
    }
    return env.createValue(buf, result);
  },
  napi_create_external_buffer(env_id, length, data, finalize_cb, finalize_hint, result) {
    let env = environments[env_id];
    return env.createValue(new BufferValue(env, data, length, env.table.get(finalize_cb), finalize_hint), result);
  },
  napi_get_buffer_info(env_id, value, data, length) {
    let env = environments[env_id];
    let buf = env.get(value);
    env.setPointer(data, buf.data);
    return env.setPointer(length, buf.length);
  },
  napi_create_arraybuffer(env_id, length, data, result) {
    let env = environments[env_id];
    return env.createValue(new BufferValue(env, data, length, null, null), result);
  },
  napi_create_external_arraybuffer(env_id, data, length, finalize_cb, finalize_hint, result) {
    let env = environments[env_id];
    return env.createValue(new BufferValue(data, length, env.table.get(finalize_cb), finalize_hint), result);
  },
  napi_get_arraybuffer_info(env_id, value, data, length) {
    let env = environments[env_id];
    let buf = env.get(value);
    env.setPointer(data, buf.data);
    return env.setPointer(length, buf.length);
  },
  napi_detach_arraybuffer(env_id, arraybuffer) {
    throw new Error('not implemented');
  },
  napi_is_detached_arraybuffer(env_id, arraybuffer, result) {
    throw new Error('not implemented');
  },
  napi_create_typedarray(env_id, type, length, arraybuffer, offset, result) {
    throw new Error('not implemented');
  },
  napi_create_dataview(env_id, length, arraybuffer, offset, result) {
    throw new Error('not implemented');
  },
  napi_get_typedarray_info(env_id, typedarray, type, length, data, arraybuffer, byte_offset) {
    throw new Error('not implemented');
  },
  napi_get_dataview_info(env_id, dataview, byte_length, data, arraybuffer, byte_offset) {
    throw new Error('not implemented');
  },
  napi_create_string_utf8(env_id, str, length, result) {
    let env = environments[env_id];
    let s = decoder.decode(env.memory.subarray(str, str + length));
    return env.createValue(s, result);
  },
  napi_get_value_string_utf8(env_id, value, buf, bufsize, result) {
    let env = environments[env_id];
    let val = env.get(value);
    if (buf == 0) {
      return env.setPointer(result, utf8Length(val));
    }
    let res = encoder.encodeInto(val, env.memory.subarray(buf, buf + bufsize - 1));
    env.memory[buf + res.written] = 0; // null terminate
    return env.setPointer(result, res.written);
  },
  napi_create_string_latin1(env_id, str, length, result) {
    let env = environments[env_id];
    let s = latin1Decoder.decode(env.memory.subarray(str, str + length));
    return env.createValue(s, result);
  },
  napi_get_value_string_latin1(env_id, value, buf, bufsize, result) {
    throw new Error('not implemented');
  },
  napi_create_string_utf16(env_id, str, length, result) {
    let env = environments[env_id];
    let s = utf16Decoder.decode(env.memory.subarray(str, str + length * 2));
    return env.createValue(s, result);
  },
  napi_get_value_string_utf16(env_id, value, buf, bufsize, result) {
    throw new Error('not implemented');
  },
  napi_create_date(env_id, time, result) {
    let env = environments[env_id];
    return env.createValue(new Date(time), result);
  },
  napi_get_date_value(env_id, value, result) {
    let env = environments[env_id];
    let date = env.get(value);
    env.f64[result >> 3] = date.valueOf();
  },
  napi_create_symbol(env_id, description, result) {
    let env = environments[env_id];
    let desc = env.get(description);
    return env.createValue(Symbol(desc), result);
  },
  napi_coerce_to_bool(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(Boolean(env.get(value)), result);
  },
  napi_coerce_to_number(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(Number(env.get(value)), result);
  },
  napi_coerce_to_object(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(Object(env.get(value)), result);
  },
  napi_coerce_to_string(env_id, value, result) {
    let env = environments[env_id];
    return env.createValue(String(env.get(value)), result);
  },
  napi_typeof(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    return env.setPointer(result, (() => {
      switch (typeof val) {
        case 'undefined':
          return 0;
        case 'boolean':
          return 2;
        case 'number':
          return 3;
        case 'string':
          return 4;
        case 'symbol':
          return 5;
        case 'object':
          if (val === null) {
            return 1;
          } else if (val instanceof ExternalValue) {
            return 8;
          }
          return 6;
        case 'function':
          return 7;
        case 'bigint':
          return 9;
      }
    })());
  },
  napi_instanceof(env_id, object, constructor, result) {
    let env = environments[env_id];
    let obj = env.get(object);
    let cons = env.get(constructor);
    env.memory[result] = obj instanceof cons ? 1 : 0;
    return NAPI_OK;
  },
  napi_is_array(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.memory[result] = Array.isArray(val) ? 1 : 0;
    return NAPI_OK;
  },
  napi_is_buffer(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.memory[result] = val instanceof BufferValue ? 1 : 0;
    return NAPI_OK;
  },
  napi_is_date(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.memory[result] = val instanceof Date ? 1 : 0;
    return NAPI_OK;
  },
  napi_is_error(env_id, value, result) {
    let env = environments[env_id];
    let err = env.get(value);
    env.memory[result] = err instanceof Error ? 1 : 0;
    return NAPI_OK;
  },
  napi_is_typedarray(env_id, value, result) {

  },
  napi_is_dataview(env_id, value, result) {

  },
  napi_strict_equals(env_id, lhs, rhs, result) {
    let env = environments[env_id];
    env.memory[result] = env.get(lhs) === env.get(rhs) ? 1 : 0;
    return NAPI_OK;
  },
  napi_wrap(env_id, js_object, native_object, finalize_cb, finalize_hint, result) {
    let env = environments[env_id];
    let obj = env.get(js_object);
    env.wrappedObjects.set(obj, native_object);
    if (finalize_cb) {
      let cb = env.table.get(finalize_cb);
      finalizationRegistry.register(obj, new FinalizeRecord(cb, finalize_hint, native_object));
    }

    if (result) {
      return napi.napi_create_reference(env_id, js_object, 1, result);
    }

    return NAPI_OK;
  },
  napi_unwrap(env_id, js_object, result) {
    let env = environments[env_id];
    let obj = env.get(js_object);
    let native_object = env.wrappedObjects.get(obj);
    env.setPointer(result, native_object);
    return NAPI_OK;
  },
  napi_remove_wrap(env_id, js_object, result) {
    let env = environments[env_id];
    let obj = env.get(js_object);
    let native_object = env.wrappedObjects.get(obj);
    finalizationRegistry.unregister(obj);
    env.wrappedObjects.delete(obj);
    return env.setPointer(result, native_object);
  },
  napi_type_tag_object(env_id, js_object, type_tag) {
    throw new Error('not implemented');
  },
  napi_check_object_type_tag(env_id, js_object, type_tag) {
    throw new Error('not implemented');
  },
  napi_add_finalizer(env_id, js_object, native_object, finalize_cb, finalize_hint, result) {
    let env = environments[env_id];
    let obj = env.get(js_object);
    let cb = env.table.get(finalize_cb);
    finalizationRegistry.register(obj, new FinalizeRecord(cb, finalize_hint, native_object));
    if (result) {
      return napi.napi_create_reference(env_id, js_object, 1, result);
    }

    return NAPI_OK;
  },
  napi_create_promise(env_id, deferred, promise) {
    let env = environments[env_id];
    let p = new Promise((resolve, reject) => {
      env.createValue({ resolve, reject }, deferred);
    });
    return env.createValue(p, promise);
  },
  napi_resolve_deferred(env_id, deferred, resolution) {
    let env = environments[env_id];
    let { resolve } = env.get(deferred);
    let value = env.get(resolution);
    resolve(value);
    env.set(deferred, undefined);
    return NAPI_OK;
  },
  napi_reject_deferred(env_id, deferred, rejection) {
    let env = environments[env_id];
    let { reject } = env.get(deferred);
    let value = env.get(rejection);
    reject(value);
    env.set(deferred, undefined);
    return NAPI_OK;
  },
  napi_is_promise(env_id, value, result) {
    let env = environments[env_id];
    let val = env.get(value);
    env.memory[result] = val instanceof Promise ? 1 : 0;
    return NAPI_OK;
  },
  napi_run_script(env_id, script, result) {
    let env = environments[env_id];
    let source = env.get(script);
    let res = (0, eval)(source);
    return env.createValue(res, result);
  },
  napi_create_external(env_id, data, finalize_cb, finalize_hint, result) {
    let env = environments[env_id];
    let external = new ExternalValue;
    env.externalObjects.set(external, data);
    if (finalize_cb) {
      let cb = env.table.get(finalize_cb);
      finalizationRegistry.register(external, new FinalizeRecord(cb, finalize_hint, data));
    }
    return env.createValue(external, result);
  },
  napi_get_value_external(env_id, value, result) {
    let env = environments[env_id];
    let external = env.get(value);
    let val = env.externalObjects.get(external);
    return env.setPointer(result, val);
  },
  napi_adjust_external_memory() {
    return NAPI_OK;
  }
};

function strlen(buf, ptr) {
  let len = 0;
  while (buf[ptr] !== 0) {
    len++;
    ptr++;
  }

  return len;
}

function utf8Length(string) {
  let len = 0;
  for (let i = 0; i < string.length; i++) {
    let c = string.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff && i < string.length - 1) {
      let c2 = string.charCodeAt(++i);
      if ((c2 & 0xfc00) === 0xdc00) {
        c = ((c & 0x3ff) << 10) + (c2 & 0x3ff) + 0x10000;
      } else {
        // unmatched surrogate.
        i--;
      }
    }

    if ((c & 0xffffff80) === 0) {
      len++;
    } else if ((c & 0xfffff800) === 0) {
      len += 2;
    } else if ((c & 0xffff0000) === 0) {
      len += 3;
    } else if ((c & 0xffe00000) === 0) {
      len += 4;
    }
  }
  return len;
}
