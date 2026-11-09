# Python function tools

A catalog app can expose a Python callable as an MCP tool. The Go engine runs
CPython **inside WebAssembly using wazero**. It does not start a host Python
process or compile each app's Python source into a separate Wasm binary.

## Setup

```sh
make python-wasm
```

This installs a checksum-pinned [WASI CPython 3.13.17 distribution](https://github.com/brettcannon/cpython-wasi-build/releases/tag/v3.13.17)
under `engine/.python-wasm/` (gitignored). Its license is retained alongside
`python.wasm` and `lib/`. `make run` and `make test` also ensure it is installed;
Docker images include it at build time. Runtime execution needs no download.

Override its location with `POCKETKNIFE_PYTHON_DIR` or the engine's
`-python-dir` flag. The directory must contain `python.wasm` and `lib/` from
a compatible WASI preview1 distribution. Python initializes lazily on its
first call, so apps using only CRUD do not pay interpreter compilation costs.

## Manifest and source

Alongside the app's existing metadata and entities:

```json
{
  "functions": [{
    "id": "fn_total",
    "name": "total",
    "runtime": "python",
    "entry": "functions/total.py",
    "handler": "calculate_total",
    "capabilities": {}
  }],
  "tools": [{
    "id": "tool_total",
    "name": "calculate_total",
    "description": "Calculate the total price for a quantity",
    "function": "fn_total",
    "params": [
      {"id": "p_price", "name": "price", "type": "real", "required": true},
      {"id": "p_quantity", "name": "quantity", "type": "integer", "required": true}
    ]
  }]
}
```

`functions/total.py` in that app's directory:

```python
def calculate_total(price, quantity):
    return {"total": round(price * quantity, 2)}
```

`function` references a function's stable **ID**. A tool must declare exactly
one of `function` or `steps`; Python calls are not mixed into CRUD transactions.
`handler` defaults to `main`. `runtime` defaults to `wasm` for existing
precompiled functions using the `pocketknife` host ABI.

The agent discovers `calculate_total` through the existing `/mcp/<app_id>`
endpoint and calls it with `{"price": 12.5, "quantity": 3}`. The engine
validates the declared parameters and invokes `calculate_total(**arguments)`,
returning `{"total":37.5}` as MCP text and structured content. No agent SDK
change is needed. Existing skill and UI-component associations also work.

Missing optional arguments without manifest defaults are omitted from the
keyword arguments, so Python defaults work. Explicit JSON `null` becomes
`None`. Objects are returned directly; lists, scalar values and `None` are
wrapped in `{"result": value}` to satisfy MCP's structured-content format.
Prints are captured separately and discarded. Exceptions, missing handlers,
syntax errors, invalid/non-finite JSON results and resource failures are MCP
tool errors (`isError: true`).

## Packages

Declare normal package requirements at the top level of the app manifest:

```json
{
  "python": {"packages": ["tzdata==2026.6", "packaging==25.0"]}
}
```

The builder resolves these requirements and their transitive dependencies with
pip for Python 3.13, downloads portable wheels, and includes them in the app's
save/install bundle. The engine extracts them to `python/site-packages/` and
mounts that directory read-only at `/packages` inside each invocation. Python
code imports them normally. `tzdata` is an ordinary package in this mechanism;
the runtime has no timezone-specific implementation.

Local development needs Python 3 and pip for dependency resolution (override
the executable with `PYTHON`). The runtime Docker image includes them. The Go
engine never executes package code on the host; no pip or network access is
needed to import an already-installed package. Resolve errors are reported by
`validate_app` before an app is presented for installation.

The generated `.python-packages/` directory caches the resolved wheels for a
draft. Changing `python.packages` resolves a new set; removing the cache forces
resolution again. Installed bundles record wheel names and SHA-256 hashes in
`python/wheels.lock.json`. Pin versions for repeatable builds. Package data,
metadata, and namespace packages are included. Wheels with native platform
extensions need a compatible Wasm build and are rejected with a clear error;
the current distribution imports portable pure-Python wheels.

## Network capability

Declare exact HTTPS hostnames on the function, for example:

```json
{
  "id": "fn_search", "name": "search", "runtime": "python",
  "entry": "functions/search.py", "handler": "search",
  "timeoutSeconds": 60,
  "capabilities": {"network": ["www.kleinanzeigen.de"]}
}
```

`urllib.request.urlopen` (including `from urllib.request import urlopen`) is
adapted to the engine's capability-checked fetch. Existing `Request`, headers,
response bytes, status, `HTTPError`, and context-manager use are supported.
The `pocketknife.urlopen` helper exposes the same adapter. Raw sockets remain
unavailable; HTTP libraries that require sockets need their own adapter.

Every redirect is checked against the host allow-list, HTTPS is enforced, and
authentication/cookie headers are stripped on cross-origin redirects. Network
requests share the invocation deadline; an optional urllib timeout can shorten
an individual request. Network responses are capped at 4 MiB and oversize
responses fail explicitly. `time.sleep` works and is interrupted by the
invocation deadline. `timeoutSeconds` can select a budget from 1 to 120 seconds;
the default is 5 seconds.

The [Kleinanzeigen example](../examples/kleinanzeigen_search/manifest.json)
combines package dependencies with a network grant and the unchanged search
script. Install package-dependent apps through the builder's normal save/install
flow so their resolved wheels are included; copying only a manifest into the
catalog does not install its dependencies.

## Installation

The build agent can write Python source using its normal file tools.
`validate_app` checks that declared source files are present, confined to the
app directory, and within the source-size limit, in addition to validating the
manifest and resolving declared packages. Python syntax and callable execution
are checked at invocation.

Saving an app submits declared Python source alongside the manifest:

```json
{
  "manifest": { "...": "complete app manifest" },
  "functionFiles": [{
    "path": "functions/total.py",
    "content": "def calculate_total(price, quantity):\n    return {'total': round(price * quantity, 2)}\n"
  }]
}
```

Resolved wheels are sent as `pythonWheels: [{"name": "distribution-version-py3-none-any.whl", "data": "<base64 wheel bytes>"}]`.
The runtime's existing save/install flow does this automatically. The engine
rejects missing, duplicate and undeclared source paths. Files are staged and
swapped with the rest of the app bundle. Calls load source fresh, so replacing
an installed function takes effect without restarting the interpreter or server.

Try the complete example:

```sh
cp -R examples/python_calculator catalog/python_calculator
make run
```

The app will be registered on boot. The web/runtime processes are started
separately with `npm run dev` if desired.

## Execution boundary and current limits

- Each invocation gets a fresh CPython/Wasm instance; globals do not persist.
- 128 MiB guest memory, a default 5-second deadline including interpreter startup
  (configurable up to 120 seconds),
  1 MiB combined source/arguments and 1 MiB output. Diagnostics are capped at
  16 KiB. Cancellation closes the invocation's Wasm module.
- The runtime's standard library and installed packages are mounted read-only. App source is
  passed through stdin; no app directory or host environment is mounted.
- Functions may import installed packages and use declared HTTPS network grants.
  Host environment, raw sockets, subprocesses and a writable filesystem remain
  unavailable. App data and model capability bridges are not implemented;
  the manifest validator rejects those grants for Python functions.
- Catalog apps still require at least one entity. Use separate CRUD tools
  when a workflow needs to read or persist app data.

`make test` runs real interpreter tests plus the HTTP save → install → MCP
discovery → call → Python/Wasm → result flow, including reinstall, argument
errors, exceptions, resource limits and filesystem confinement.
