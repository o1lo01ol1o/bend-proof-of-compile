// Host capability adapter for the compiled Bend application.
// POC_HOST is installed by the TypeScript preload before the generated Bend
// JavaScript starts. This file contains no cache-key or invalidation logic.

function poc_host() {
  if (globalThis.POC_HOST === undefined) {
    throw new Error("proof-of-compile host preload is missing");
  }
  return globalThis.POC_HOST;
}

function poc_done(value) {
  return { $: "Done", value };
}

function poc_fail(error) {
  return { $: "Fail", error: String(error?.message ?? error) };
}

function poc_try(action) {
  try {
    return poc_done(action());
  } catch (error) {
    return poc_fail(error);
  }
}

function poc_async(promise, kont) {
  Promise.resolve(promise).then(
    (value) => io_push(kont, poc_done(value), false),
    (error) => io_push(kont, poc_fail(error), false),
  );
  return undefined;
}

function poc_list_to_array(list) {
  const values = [];
  for (let cursor = list; cursor.$ === "Con"; cursor = cursor.tail) {
    values.push(cursor.head);
  }
  return values;
}

function poc_strings(values) {
  let result = { $: "Nil" };
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result = { $: "Con", head: values[index], tail: result };
  }
  return result;
}

function poc_compile_steps(steps) {
  let result = { $: "Nil" };
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    result = {
      $: "Con",
      head: {
        $: "CompileStep",
        file: steps[index].file,
        namespace: steps[index].namespace,
        key: steps[index].key,
      },
      tail: result,
    };
  }
  return result;
}

function poc_named_bytes(files) {
  let result = { $: "Nil" };
  for (let index = files.length - 1; index >= 0; index -= 1) {
    result = {
      $: "Con",
      head: { $: "NamedBytes", path: files[index].path, bytes: files[index].bytes },
      tail: result,
    };
  }
  return result;
}

function host_cache_root(namespace, version) {
  return poc_host().cacheRoot(namespace, version);
}

function host_default_base() {
  return poc_host().defaultBase();
}

function host_compiler_inputs() {
  return poc_try(() => {
    const inputs = poc_host().compilerInputs();
    return {
      $: "CompilerInputs",
      compiler: poc_named_bytes(inputs.compiler),
      hashes: poc_named_bytes(inputs.hashes),
    };
  });
}

function host_realpath(file) {
  return poc_try(() => poc_host().realpath(file));
}

function host_resolve(owner, specifier) {
  return poc_try(() => poc_host().resolve(owner, specifier));
}

function host_read_source(file) {
  return poc_try(() => {
    const source = poc_host().readSource(file);
    return {
      $: "SourceFile",
      text: source.text,
      lines: poc_strings(source.lines),
      bytes: source.bytes,
    };
  });
}

function host_state_get(cache, key) {
  return poc_try(() => {
    const state = poc_host().stateGet(cache, key);
    return state === null
      ? { $: "None" }
      : { $: "Some", value: { $: "Checkpoint", token: state } };
  });
}

function host_state_get_longest(cache, candidates) {
  return poc_try(() => {
    const plan = poc_list_to_array(candidates).map((candidate) => ({
      key: candidate.key,
      steps: poc_list_to_array(candidate.steps),
    }));
    const found = poc_host().stateGetLongest(cache, plan);
    return found === null
      ? { $: "None" }
      : {
          $: "Some",
          value: io_tup(
            { $: "Checkpoint", token: found.state },
            poc_compile_steps(found.steps),
          ),
        };
  });
}

function host_stage_start() {
  return poc_try(() => ({ $: "Stage", token: poc_host().stageStart() }));
}

function host_stage_commit(stage) {
  return poc_try(() => {
    poc_host().stageCommit(stage.token);
    return { $: "Unit" };
  });
}

function host_stage_abort(stage) {
  poc_host().stageAbort(stage.token);
  return { $: "Unit" };
}

function host_book_read_suffix(cache, entry, state_key, steps, seed, stage) {
  try {
    const unsafeSeed = seed.$ === "Some" ? seed.value.token : undefined;
    const checked = poc_host().bookReadSuffix(
      cache,
      entry,
      state_key,
      poc_list_to_array(steps),
      unsafeSeed,
      stage.token,
    );
    return poc_done(io_tup(
      { $: "Checkpoint", token: checked.state },
      { $: "Stage", token: checked.stage },
    ));
  } catch (error) {
    return poc_fail(error);
  }
}

function host_artifact_restore(cache, key, output) {
  return poc_try(() => poc_host().artifactRestore(cache, key, output));
}

function host_output_remove(output) {
  poc_host().outputRemove(output);
  return { $: "Unit" };
}

function host_artifact_build(cache, key, output, target, state) {
  return poc_try(() => {
    poc_host().artifactBuild(cache, key, output, target, state.token);
    return { $: "Unit" };
  });
}

function host_cache_status(cache) {
  return poc_try(() => JSON.stringify(poc_host().cacheStatus(cache)));
}

function host_cache_verify(cache) {
  return poc_try(() => JSON.stringify(poc_host().cacheVerify(cache)));
}

function host_cache_gc(cache, live) {
  return poc_try(() => JSON.stringify(poc_host().cacheGc(cache, poc_list_to_array(live))));
}
