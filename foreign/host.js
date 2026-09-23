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

// An asynchronous capability: the host's IO loop awaits the returned promise
// and resumes the Bend continuation with its Result.
function poc_await(action) {
  return Promise.resolve().then(action).then(poc_done, poc_fail);
}

function poc_list_to_array(list) {
  const values = [];
  for (let cursor = list; cursor.$ === "Con"; cursor = cursor.tail) {
    values.push(cursor.head);
  }
  return values;
}

function poc_list(values, convert) {
  let result = { $: "Nil" };
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result = { $: "Con", head: convert(values[index]), tail: result };
  }
  return result;
}

function poc_maybe(value, convert) {
  return value === null ? { $: "None" } : { $: "Some", value: convert(value) };
}

function poc_named_bytes(file) {
  return { $: "NamedBytes", path: file.path, bytes: file.bytes };
}

function poc_load_step(step) {
  return { $: "LoadStep", path: step.path, namespace: step.namespace, text: step.text };
}

function poc_step_from_bend(step) {
  return { path: step.path, namespace: step.namespace, text: step.text };
}

function poc_groups_to_host(groups) {
  return poc_list_to_array(groups).map((group) => ({
    steps: poc_list_to_array(group.steps).map(poc_step_from_bend),
    key: group.key,
  }));
}

function poc_group(group) {
  return {
    $: "CheckGroup",
    steps: poc_list(group.steps, poc_load_step),
    key: group.key,
  };
}

function poc_entry_rule(rule) {
  return rule.$ === "PlainEntry"
    ? { $: "PlainEntry" }
    : { $: "ProofEntry", laws: poc_maybe(rule.laws, (laws) => laws) };
}

function poc_late_fill(fill) {
  return {
    $: "LateFill",
    declared: BigInt(fill.declared),
    filled: BigInt(fill.filled),
    flags: poc_list(fill.flags, (flag) => ({ $: flag })),
  };
}

function host_cache_root(namespace, version) {
  return poc_try(() => poc_host().cacheRoot(namespace, version));
}

function host_compiler_inputs() {
  return poc_try(() => {
    const inputs = poc_host().compilerInputs();
    return {
      $: "CompilerInputs",
      compiler: poc_list(inputs.compiler, poc_named_bytes),
      hashes: poc_list(inputs.hashes, poc_named_bytes),
    };
  });
}

function host_load_steps(entry) {
  return poc_await(async () => {
    const order = await poc_host().loadSteps(entry);
    return {
      $: "LoadOrder",
      imports: poc_list(order.imports, poc_load_step),
      entry: poc_load_step(order.entry),
      rule: poc_entry_rule(order.rule),
    };
  });
}

function host_load_fills(root, steps) {
  return poc_await(async () => {
    const fills = await poc_host().loadFills(
      root,
      poc_list_to_array(steps).map(poc_step_from_bend),
    );
    return poc_list(fills, poc_late_fill);
  });
}

function poc_verdict(verdict) {
  return {
    $: "Verdict",
    todos: BigInt(verdict.todos),
    reliant: poc_list(verdict.reliant, (name) => name),
  };
}

function host_state_get(cache, key) {
  return poc_try(() => poc_maybe(
    poc_host().stateGet(cache, key),
    (found) => io_tup({ $: "Checkpoint", token: found.state }, poc_verdict(found.verdict)),
  ));
}

function host_state_get_longest(cache, candidates) {
  return poc_try(() => {
    const plan = poc_list_to_array(candidates).map((candidate) => ({
      key: candidate.key,
      groups: poc_groups_to_host(candidate.groups),
    }));
    return poc_maybe(
      poc_host().stateGetLongest(cache, plan),
      (found) => io_tup(
        { $: "Checkpoint", token: found.state },
        poc_list(found.groups, poc_group),
      ),
    );
  });
}

function host_state_foreigns(cache, key) {
  return poc_try(() => poc_maybe(
    poc_host().stateForeigns(cache, key),
    (files) => poc_list(files, poc_named_bytes),
  ));
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

function host_book_check(cache, root, groups, seed, stage) {
  return poc_await(async () => {
    const checked = await poc_host().bookCheck(
      cache,
      root,
      poc_groups_to_host(groups),
      seed.$ === "Some" ? seed.value.token : undefined,
      stage.token,
    );
    return io_tup(
      { $: "Checkpoint", token: checked.state },
      { $: "Stage", token: checked.stage },
      poc_verdict(checked.verdict),
    );
  });
}

function host_output_path(output) {
  return poc_try(() => {
    const observed = poc_host().outputPath(output);
    return { $: observed.directory ? "OutputDirectory" : "OutputFile", real: observed.real };
  });
}

function host_artifact_restore(cache, key, output) {
  return poc_try(() => poc_maybe(
    poc_host().artifactRestore(cache, key, output),
    (reliant) => poc_list(reliant, (name) => name),
  ));
}

function host_output_remove(output) {
  poc_host().outputRemove(output);
  return { $: "Unit" };
}

function host_artifact_build(cache, key, output, target, state, reliant) {
  return poc_try(() => {
    poc_host().artifactBuild(cache, key, output, target, state.token, poc_list_to_array(reliant));
    return { $: "Unit" };
  });
}

function host_roots_put(cache, root, live) {
  return poc_try(() => {
    poc_host().rootsPut(cache, root, poc_list_to_array(live));
    return { $: "Unit" };
  });
}

function host_roots_live(cache) {
  return poc_try(() => poc_list(poc_host().rootsLive(cache), (key) => key));
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
