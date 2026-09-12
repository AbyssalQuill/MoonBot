"""
RedReply / NapCat 音乐签名中间层 v4 (用户提供,本地集成)
CZ_MUSIC_KEY 默认空;端口 4567;端点 /music_card/card
"""
from __future__ import annotations
import json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

VERSION = "2026-08-18-music-sign-proxy-v4-redreply-napcat"
HOST = os.environ.get("MUSIC_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("MUSIC_PROXY_PORT", "4567"))
CZ_API = os.environ.get("CZ_MUSIC_API", "https://api.czcn.xyz/api/qqyykp")
CZ_KEY = os.environ.get("CZ_MUSIC_KEY", "")
CZ_TYPE = os.environ.get("CZ_MUSIC_TYPE", "qq")
UPSTREAM_TIMEOUT = float(os.environ.get("CZ_MUSIC_TIMEOUT", "15"))
SIGN_PATHS = {"/", "/music_card/card", "/api/music/sign", "/sign"}
HEALTH_PATHS = {"/health", "/healthz"}
DEBUG_RAW = os.environ.get("MUSIC_PROXY_DEBUG", "1").lower() not in {"0", "false", "off", "no"}

def log(message: str) -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {message}", flush=True)

def scalar(value: Any, default: str = "") -> str:
    if value is None: return default
    if isinstance(value, list): return scalar(value[0] if value else "", default)
    if isinstance(value, (dict, tuple)): return default
    return str(value).strip()

def flatten_query(data: dict[str, list[str]]) -> dict[str, str]:
    return {key: scalar(value) for key, value in data.items()}

def read_chunked_body(handler: BaseHTTPRequestHandler) -> bytes:
    chunks: list[bytes] = []
    while True:
        line = handler.rfile.readline()
        if not line: raise ValueError("chunked 请求体提前结束")
        size_line = line.strip().split(b";", 1)[0]
        if not size_line: continue
        try: size = int(size_line, 16)
        except ValueError as error: raise ValueError(f"非法 chunk size: {size_line!r}") from error
        if size == 0:
            while True:
                trailer = handler.rfile.readline()
                if trailer in (b"\r\n", b"\n", b""): break
            break
        chunk = handler.rfile.read(size)
        if len(chunk) != size: raise ValueError(f"chunk 数据不完整: 期望 {size},实际 {len(chunk)}")
        chunks.append(chunk)
        crlf = handler.rfile.read(2)
        if crlf not in (b"\r\n", b"\n"): raise ValueError(f"chunk 结束符异常: {crlf!r}")
    return b"".join(chunks)

def read_request_body(handler: BaseHTTPRequestHandler) -> bytes:
    transfer_encoding = (handler.headers.get("Transfer-Encoding") or "").lower()
    if "chunked" in transfer_encoding: return read_chunked_body(handler)
    content_length = handler.headers.get("Content-Length")
    if content_length:
        try: length = int(content_length)
        except ValueError: length = 0
        if length > 0: return handler.rfile.read(length)
    return b""

def recursively_collect(obj: Any, out: dict[str, Any], depth: int = 0) -> None:
    if depth > 8: return
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in {"type", "url", "audio", "title", "singer", "content", "desc", "image"}:
                if key not in out or not scalar(out.get(key)): out[key] = value
        for value in obj.values(): recursively_collect(value, out, depth + 1)
        return
    if isinstance(obj, list):
        for value in obj: recursively_collect(value, out, depth + 1)
        return
    if isinstance(obj, str):
        value = obj.strip()
        if len(value) >= 2 and value[0] in "[{" and value[-1] in "]}":
            try: recursively_collect(json.loads(value), out, depth + 1)
            except json.JSONDecodeError: pass

def parse_body_bytes(raw: bytes, content_type: str) -> dict[str, Any]:
    if not raw: return {}
    decoded = raw.decode("utf-8-sig", errors="replace").strip()
    if not decoded: return {}
    if "application/json" in content_type or decoded.startswith("{") or decoded.startswith("["):
        try:
            obj = json.loads(decoded); result: dict[str, Any] = {}; recursively_collect(obj, result); return result
        except json.JSONDecodeError: pass
    form = flatten_query(parse_qs(decoded, keep_blank_values=True))
    result: dict[str, Any] = dict(form)
    for value in list(form.values()): recursively_collect(value, result)
    return result

def parse_request_data(handler: BaseHTTPRequestHandler) -> tuple[dict[str, Any], bytes]:
    parsed = urlparse(handler.path)
    data: dict[str, Any] = flatten_query(parse_qs(parsed.query, keep_blank_values=True))
    raw = b""
    if handler.command in {"POST", "PUT", "PATCH"}:
        raw = read_request_body(handler)
        content_type = (handler.headers.get("Content-Type") or "").lower()
        data.update(parse_body_bytes(raw, content_type))
    normalized: dict[str, Any] = {}
    recursively_collect(data, normalized)
    for key, value in data.items(): normalized.setdefault(key, value)
    return normalized, raw

def translate_napcat_to_cz(source: dict[str, Any]) -> dict[str, str]:
    is_snowluma = any(scalar(source.get(key)) for key in ("song", "cover", "jump"))
    if is_snowluma:
        audio = scalar(source.get("audio") or source.get("url"))
        jump_url = scalar(source.get("jump") or source.get("url"))
        title = scalar(source.get("song") or source.get("title"))
        singer = scalar(source.get("singer") or source.get("content") or source.get("desc"))
        image = scalar(source.get("cover") or source.get("image"))
        source_protocol = "RedReply"
    else:
        jump_url = scalar(source.get("url") or source.get("jump"))
        audio = scalar(source.get("audio"))
        title = scalar(source.get("title") or source.get("song"))
        singer = scalar(source.get("singer") or source.get("content") or source.get("desc"))
        image = scalar(source.get("image") or source.get("cover"))
        source_protocol = "NapCat"
    missing = [name for name, value in (("url/jump", jump_url), ("audio", audio), ("title/song", title), ("image/cover", image)) if not value]
    if missing:
        raise ValueError(f"{source_protocol} 请求缺少参数: " + ", ".join(missing) + "；收到字段=" + ",".join(sorted(source.keys())))
    log(f"识别协议={source_protocol} | 原format={scalar(source.get('format')) or '-'} | CZ type 强制=qq")
    return {"key": CZ_KEY, "type": CZ_TYPE, "url": jump_url, "audio": audio, "title": title, "desc": singer, "image": image}

def decode_json_response(raw: bytes) -> Any:
    text = raw.decode("utf-8-sig", errors="replace").strip()
    if not text: raise RuntimeError("CZ API 返回空内容")
    try: return json.loads(text)
    except json.JSONDecodeError as error: raise RuntimeError(f"CZ API 返回非 JSON: {text[:500]}") from error

def is_music_payload(payload: Any) -> bool:
    if not isinstance(payload, dict): return False
    meta = payload.get("meta"); music = meta.get("music") if isinstance(meta, dict) else None
    return str(payload.get("view", "")).lower() == "music" and isinstance(music, dict)

def is_redreply_request(source: dict[str, Any]) -> bool:
    return any(scalar(source.get(key)) for key in ("song", "cover", "jump"))

def wrap_redreply_success(payload: dict[str, Any]) -> dict[str, str]:
    return {"code": "1", "message": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}

def wrap_redreply_error(message: str) -> dict[str, str]:
    return {"code": "0", "message": str(message)}

def call_cz_api(params: dict[str, str]) -> dict[str, Any]:
    headers = {"Accept": "application/json", "User-Agent": "NapCat-MusicSign-Proxy/2.0"}
    errors: list[str] = []
    try:
        request_url = CZ_API + ("&" if "?" in CZ_API else "?") + urlencode(params)
        with urlopen(Request(request_url, headers=headers, method="GET"), timeout=UPSTREAM_TIMEOUT) as response:
            payload = decode_json_response(response.read())
            if is_music_payload(payload): return payload
            errors.append("GET 返回非音乐签名 JSON: " + json.dumps(payload, ensure_ascii=False)[:500])
    except HTTPError as error:
        errors.append(f"GET HTTP {error.code}: {error.read().decode('utf-8', errors='replace')[:500]}")
    except (URLError, OSError, RuntimeError, ValueError) as error:
        errors.append(f"GET: {error}")
    try:
        body = urlencode(params).encode("utf-8")
        post_headers = dict(headers); post_headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
        with urlopen(Request(CZ_API, data=body, headers=post_headers, method="POST"), timeout=UPSTREAM_TIMEOUT) as response:
            payload = decode_json_response(response.read())
            if is_music_payload(payload): return payload
            errors.append("POST 返回非音乐签名 JSON: " + json.dumps(payload, ensure_ascii=False)[:500])
    except HTTPError as error:
        errors.append(f"POST HTTP {error.code}: {error.read().decode('utf-8', errors='replace')[:500]}")
    except (URLError, OSError, RuntimeError, ValueError) as error:
        errors.append(f"POST: {error}")
    raise RuntimeError("；".join(errors) or "CZ API 调用失败")

class MusicSignHandler(BaseHTTPRequestHandler):
    server_version = "NapCatMusicSignProxy/2.0"
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.client_address[0]} {fmt % args}")
    def send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True
    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in HEALTH_PATHS:
            self.send_json(200, {"ok": True, "version": VERSION, "service": "napcat-music-sign-proxy", "upstream": CZ_API, "type": CZ_TYPE})
            return
        self.handle_sign(path)
    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        self.handle_sign(path)
    def handle_sign(self, path: str) -> None:
        if path not in SIGN_PATHS:
            self.send_json(404, {"ok": False, "error": "not found"})
            return
        redreply_mode = False
        try:
            source, raw = parse_request_data(self)
            redreply_mode = is_redreply_request(source)
            if DEBUG_RAW:
                log("RAW method=" + self.command + " path=" + repr(self.path) + " ct=" + repr(self.headers.get('Content-Type')) + " cl=" + repr(self.headers.get('Content-Length')) + " te=" + repr(self.headers.get('Transfer-Encoding')))
                log("RAW BODY=" + raw.decode("utf-8", errors="replace")[:3000])
                log("PARSED=" + json.dumps(source, ensure_ascii=False, separators=(",", ":"))[:3000])
            cz_params = translate_napcat_to_cz(source)
            log("签名请求: title=" + repr(cz_params['title']) + " desc=" + repr(cz_params['desc']) + " audio=" + repr(cz_params['audio'][:100]))
            payload = call_cz_api(cz_params)
            if redreply_mode:
                wrapped = wrap_redreply_success(payload)
                log("返回模式=RedReply code=1 bytes=" + str(len(wrapped['message'].encode('utf-8'))))
                self.send_json(200, wrapped)
            else:
                log("返回模式=NapCat RAW JSON")
                self.send_json(200, payload)
        except ValueError as error:
            log(f"请求参数错误: {error}")
            self.send_json(200 if redreply_mode else 400, wrap_redreply_error(str(error)) if redreply_mode else {"ok": False, "error": str(error)})
        except Exception as error:
            log(f"签名失败: {error}")
            self.send_json(200 if redreply_mode else 502, wrap_redreply_error(str(error)) if redreply_mode else {"ok": False, "error": str(error)})

def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), MusicSignHandler)
    log(f"{VERSION} 已启动: http://{HOST}:{PORT}/music_card/card")
    log(f"CZ 上游: {CZ_API} | type={CZ_TYPE} | key_len={len(CZ_KEY)}")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__ == "__main__":
    main()
