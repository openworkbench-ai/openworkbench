"""Trusted bootstrap; all guest authority is rechecked by the Go host."""
import contextlib
import json
import sys
import types
import time

_output = sys.stdout
_input = sys.stdin


def _exchange(message):
    _output.write(json.dumps(message, allow_nan=False) + "\n")
    _output.flush()
    response = json.loads(_input.readline())
    if response["code"] < 0:
        import urllib.error
        detail = response.get("response", {}).get("error", "network capability denied")
        raise urllib.error.URLError(detail)
    return response


def _network_fetch(request):
    return _exchange({"type": "network", "request": request})["response"]


def _sleep(seconds):
    import math
    if not isinstance(seconds, (int, float)):
        raise TypeError("sleep duration must be a number")
    if seconds < 0 or not math.isfinite(seconds):
        raise ValueError("sleep duration must be finite and nonnegative")
    _exchange({"type": "sleep", "seconds": seconds})


time.sleep = _sleep


def _urlopen(url, data=None, timeout=None, *, context=None):
    import base64
    import io
    import urllib.error
    import urllib.parse
    import urllib.request
    import urllib.response
    from email.message import Message
    from http.client import responses
    if context is not None:
        raise ValueError("TLS configuration is owned by the engine")
    if timeout is not None and timeout <= 0:
        raise ValueError("timeout must be positive")
    request = url if isinstance(url, urllib.request.Request) else urllib.request.Request(url, data=data)
    body = request.data if data is None else data
    method = request.get_method()
    headers = dict(request.header_items())
    full_url = request.full_url
    for redirect in range(6):
        parsed = urllib.parse.urlsplit(full_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443)):
            raise urllib.error.URLError("only HTTPS URLs on declared hosts are supported")
        message = {
            "host": parsed.hostname,
            "path": (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
            "method": method,
            "headers": headers,
            "binary": True,
        }
        if body is not None:
            message["bodyBase64"] = base64.b64encode(body).decode("ascii")
        if timeout is not None:
            message["timeoutSeconds"] = timeout
        result = _network_fetch(message)
        status = result["status"]
        response_headers = Message()
        for key, value in result.get("headers", {}).items():
            response_headers[key] = value
        response_body = base64.b64decode(result.get("bodyBase64", ""))
        location = response_headers.get("Location")
        if status in (301, 302, 303, 307, 308) and location:
            if redirect == 5:
                raise urllib.error.URLError("too many redirects")
            next_url = urllib.parse.urljoin(full_url, location)
            if urllib.parse.urlsplit(next_url).netloc != parsed.netloc:
                headers = {k: v for k, v in headers.items() if k.lower() not in ("authorization", "cookie")}
            if (status in (301, 302) and method == "POST") or (status == 303 and method != "HEAD"):
                method, body = "GET", None
                headers = {k: v for k, v in headers.items() if k.lower() not in ("content-type", "content-length")}
            full_url = next_url
            continue
        if not 200 <= status < 300:
            raise urllib.error.HTTPError(full_url, status, responses.get(status, ""), response_headers, io.BytesIO(response_body))
        response = urllib.response.addinfourl(io.BytesIO(response_body), response_headers, full_url, status)
        response.reason = responses.get(status, "")
        return response


# Install before executing source, so existing `from urllib.request import
# urlopen` calls use the gated bridge. Raw sockets remain unavailable.
_module = types.ModuleType("pocketknife")
_module.urlopen = _urlopen
_module.network_fetch = _network_fetch
sys.modules["pocketknife"] = _module

try:
    _request = json.loads(_input.readline())
    if not isinstance(_request["args"], dict):
        raise TypeError("tool arguments must be an object")
    with contextlib.redirect_stdout(sys.stderr):
        if _request["network"]:
            import urllib.request
            urllib.request.urlopen = _urlopen
        import site
        site.addsitedir("/packages")
        _namespace = {"__name__": "__tool__", "__file__": "/app/function.py"}
        exec(compile(_request["source"], "/app/function.py", "exec"), _namespace)
        _function = _namespace.get(_request["handler"])
        if not callable(_function):
            raise TypeError("Python handler is missing or not callable: " + _request["handler"])
        _result = _function(**_request["args"])
        _encoded = json.dumps({"type": "result", "ok": True, "result": _result}, allow_nan=False)
except BaseException as _error:
    _encoded = json.dumps({"type": "result", "ok": False, "error": type(_error).__name__ + ": " + str(_error)})
_output.write(_encoded + "\n")
_output.flush()
