from __future__ import annotations

import asyncio
import collections
import hmac
import importlib
import json
import os
import platform
import re
import shutil
import socket
import sys
import tempfile
import time
import tomllib
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web
from loguru import logger as _loguru_logger

from neobot_modloader import BasePlugin


_PROCESS_STARTED_AT = time.time()


# 工具
def _read_cpu_jiffies() -> tuple[int, int] | None:
    try:
        with open("/proc/stat", "r") as f:
            line = f.readline()
        parts = line.split()
        if not parts or parts[0] != "cpu":
            return None
        nums = [int(x) for x in parts[1:8]]
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)  # idle + iowait
        total = sum(nums)
        return idle, total
    except (FileNotFoundError, ValueError, OSError):
        return None


def _read_mem_info() -> tuple[float, float] | None:
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                k, _, v = line.partition(":")
                try:
                    info[k.strip()] = int(v.strip().split()[0])  # kB
                except (ValueError, IndexError):
                    continue
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        if total <= 0:
            return None
        used_mb = (total - avail) / 1024.0
        total_mb = total / 1024.0
        return used_mb, total_mb
    except (FileNotFoundError, OSError):
        return None


# 主插件
class DashboardPlugin(BasePlugin):
    name = "dashboard"
    version = "0.9.0"

    def __init__(self) -> None:
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._log_buffer: collections.deque[dict[str, Any]] = collections.deque(maxlen=2000)
        self._log_sink_id: int | None = None
        self._log_seq: int = 0
        self._log_sink_calls: int = 0
        self._stats_path: Path | None = None
        self._stats: dict[str, Any] = {
            "total": 0, "today": 0, "today_date": "",
            "history": [],
        }
        self._stats_lock = asyncio.Lock()
        self._history_max_days = 30
        # CPU采样
        self._last_cpu_sample: tuple[int, int] | None = _read_cpu_jiffies()
        # Bot信息缓存
        self._bot_info_cache: dict[str, Any] = {}
        self._bot_info_cache_at: float = 0.0
        self._bot_info_lock: asyncio.Lock | None = None
        # Bot延迟测量
        self._latency_ms: int | None = None
        self._latency_at: float = 0.0
        self._latency_task: asyncio.Task | None = None
        # 心跳延迟
        self._latency_history: collections.deque[tuple[float, int | None]] = collections.deque(maxlen=60)
        # API调用计数
        self._api_call_counts: dict[str, int] = {}
        # 活跃用户
        self._user_activity: dict[int, dict[str, Any]] = {}
        self._user_activity_max = 200
        # 插件管理
        self._manage_plugins: bool = False
        self._update_cache: dict[str, tuple[float, str | None]] = {}
        self._update_cache_ttl: float = 3600.0
        # 设备Token
        self._device_tokens: dict[str, dict[str, Any]] = {}
        self._device_tokens_path: Path | None = None
        self._device_tokens_lock: asyncio.Lock | None = None
        self._asset_version: int = int(time.time())
        # 热重载
        self._runtime: Any = None
        self._hot_reload_lock: asyncio.Lock | None = None
        self._latency_ms: float | None = None
        self._latency_at: float = 0.0
        # 配置
        self._host = "127.0.0.1"
        self._port = 8083
        self._token = ""
        self._bot_info_ttl = 30.0
        self._login_failures: dict[str, collections.deque[float]] = {}
        self._login_max_failures = 3
        self._login_rate_limit_window = 600

    async def on_load(self, ctx):
        self.ctx = ctx

        self._host = str(ctx.config.get("host", "127.0.0.1"))
        self._port = int(ctx.config.get("port", 8083))
        configured_token = str(ctx.config.get("access_token", "") or "").strip()
        token_file = ctx.data_dir / "access_token.txt"
        if configured_token:
            self._token = configured_token
            self._token_source = "config"
        elif token_file.exists():
            try:
                self._token = token_file.read_text(encoding="utf-8").strip()
                self._token_source = "file"
            except Exception:
                self._token = ""
                self._token_source = "config"
        else:
            self._token = ""
            self._token_source = "config"

        if not self._token:
            # 生成随机token
            import secrets
            self._token = secrets.token_urlsafe(32)
            self._token_source = "auto"
            try:
                token_file.parent.mkdir(parents=True, exist_ok=True)
                token_file.write_text(self._token, encoding="utf-8")
                try:
                    os.chmod(token_file, 0o600)
                except OSError:
                    pass
            except Exception as e:
                ctx.logger.warning(f"无法写入 access_token.txt: {e},token 不会持久化")
        self._token_file = token_file

        self._bot_info_ttl = float(ctx.config.get("bot_info_cache_ttl", 300))
        buf_size = int(ctx.config.get("log_buffer_size", 2000))
        self._log_buffer = collections.deque(maxlen=buf_size)
        self._history_max_days = int(ctx.config.get("history_max_days", 30))
        self._manage_plugins = bool(ctx.config.get("manage_plugins", False))

        self._login_max_failures = max(1, int(ctx.config.get("login_max_failures", 3)))
        self._login_rate_limit_window = max(
            10,
            int(ctx.config.get("login_rate_limit_window_seconds", 600))
        )

        self._bot_info_lock = asyncio.Lock()
        self._device_tokens_lock = asyncio.Lock()
        self._hot_reload_lock = asyncio.Lock()

        self._runtime = self._find_runtime(ctx)
        if self._runtime is None:
            ctx.logger.warning(
                "无法反射 PluginRuntime —— 插件管理操作将退化为需要重启 NeoBot 生效。"
                "可能 modloader 内部结构变了,请联系 dashboard 作者。"
            )
        else:
            ctx.logger.info(
                f"已就绪热重载支持 (runtime={type(self._runtime).__name__})"
            )

        self._device_tokens_path = ctx.data_dir / "device_tokens.json"
        self._load_device_tokens()

        self._stats_path = ctx.data_dir / "stats.json"
        self._load_stats()

        api_call_re = re.compile(r"发送API请求.*?['\"]action['\"]\s*:\s*['\"]([a-zA-Z_]+)['\"]")

        def _sink(message) -> None:
            try:
                self._log_sink_calls += 1
            except Exception:
                pass
            try:
                record = message.record
            except Exception:
                return
            try:
                self._log_seq += 1
            except Exception:
                pass

            item: dict[str, Any] = {
                "id": self._log_seq,
                "ts": 0.0, "time": "—", "datetime": "",
                "level": "info", "module": "—", "message": "",
            }
            try:
                t = record["time"]
                item["ts"] = t.timestamp()
                item["time"] = t.strftime("%H:%M:%S")
                item["datetime"] = t.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass
            try:
                item["level"] = record["level"].name.lower()
            except Exception:
                pass
            try:
                item["module"] = record.get("name") or "—"
            except Exception:
                pass
            try:
                item["message"] = str(record["message"])
            except Exception:
                pass

            try:
                self._log_buffer.append(item)
            except Exception:
                pass

            try:
                msg = item["message"]
                if "发送API请求" in msg:
                    m = api_call_re.search(msg)
                    if m:
                        action = m.group(1)
                        self._api_call_counts[action] = self._api_call_counts.get(action, 0) + 1
            except Exception:
                pass

        self._log_sink_id = _loguru_logger.add(_sink, level="INFO", enqueue=False)

        @ctx.on.message(priority=-100)
        async def _count_messages(event: dict) -> None:
            async with self._stats_lock:
                today = datetime.now().strftime("%Y-%m-%d")
                if self._stats.get("today_date") != today:
                    prev_date = self._stats.get("today_date")
                    prev_count = int(self._stats.get("today", 0))
                    if prev_date and prev_count > 0:
                        hist = self._stats.setdefault("history", [])
                        if not hist or hist[-1].get("date") != prev_date:
                            hist.append({"date": prev_date, "count": prev_count})
                        if len(hist) > self._history_max_days:
                            self._stats["history"] = hist[-self._history_max_days:]
                    self._stats["today_date"] = today
                    self._stats["today"] = 0
                    self._save_stats()
                self._stats["total"] = int(self._stats.get("total", 0)) + 1
                self._stats["today"] = int(self._stats.get("today", 0)) + 1
                if self._stats["total"] % 20 == 0:
                    self._save_stats()

                uid = event.get("user_id")
                if isinstance(uid, int) and uid > 0:
                    sender = event.get("sender") or {}
                    nick = (sender.get("card") or sender.get("nickname") or "").strip()
                    rec = self._user_activity.get(uid)
                    now_ts = time.time()
                    if rec is None:
                        if len(self._user_activity) >= self._user_activity_max:
                            oldest = min(self._user_activity.items(),
                                         key=lambda kv: kv[1].get("last_seen", 0))
                            self._user_activity.pop(oldest[0], None)
                        self._user_activity[uid] = {"count": 1, "last_seen": now_ts, "nickname": nick}
                    else:
                        rec["count"] += 1
                        rec["last_seen"] = now_ts
                        if nick:
                            rec["nickname"] = nick

    async def on_start(self) -> None:
        token = self._token

        OPEN_PATHS = {
            "/", "/login.html", "/favicon.ico",
            "/api/auth/login",
        }

        @web.middleware
        async def auth_middleware(request: web.Request, handler):
            path = request.path
            if (path in OPEN_PATHS
                    or path.startswith("/css/")
                    or path.startswith("/js/")
                    or path.startswith("/image/")
                    or path.startswith("/fonts/")):
                return await handler(request)
            if path.startswith("/api/") and token:
                tk = (
                    request.headers.get("X-Token")
                    or request.query.get("token")
                    or ""
                )
                if tk != token and tk not in self._device_tokens:
                    return web.json_response({"error": "unauthorized"}, status=401)
            return await handler(request)

        @web.middleware
        async def no_cache_middleware(request: web.Request, handler):
            response = await handler(request)
            p = request.path
            if p == "/" or p == "/login.html" or p.startswith("/js/") or p.startswith("/css/"):
                response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                response.headers["Pragma"] = "no-cache"
                response.headers["Expires"] = "0"
            elif p.startswith("/image/") or p.startswith("/fonts/"):
                response.headers["Cache-Control"] = "public, max-age=86400, immutable"
            return response

        app = web.Application(middlewares=[no_cache_middleware, auth_middleware])
        # 首页,登录页,静态资源
        app.router.add_get("/", self._handle_index)
        app.router.add_get("/login.html", self._handle_login_page)
        app.router.add_get("/favicon.ico", self._handle_favicon)
        web_root = self.ctx.plugin_dir / "web"
        if (web_root / "css").exists():
            app.router.add_static("/css/", path=web_root / "css", show_index=False)
        if (web_root / "js").exists():
            app.router.add_static("/js/", path=web_root / "js", show_index=False)
        if (web_root / "image").exists():
            app.router.add_static("/image/", path=web_root / "image", show_index=False)
        if (web_root / "fonts").exists():
            app.router.add_static("/fonts/", path=web_root / "fonts", show_index=False)
        app.router.add_post("/api/auth/login", self._api_auth_login)
        app.router.add_post("/api/auth/logout", self._api_auth_logout)
        app.router.add_get("/api/auth/me", self._api_auth_me)
        app.router.add_get("/api/auth/devices", self._api_auth_devices)
        app.router.add_post("/api/auth/devices/revoke", self._api_auth_devices_revoke)
        # API
        app.router.add_get("/api/overview", self._api_overview)
        app.router.add_get("/api/bots", self._api_bots)
        app.router.add_get("/api/bot/detail", self._api_bot_detail)
        app.router.add_get("/api/plugins", self._api_plugins)
        app.router.add_get("/api/logs", self._api_logs)
        app.router.add_get("/api/system", self._api_system)
        app.router.add_get("/api/series/messages", self._api_series_messages)
        app.router.add_get("/api/series/latency", self._api_series_latency)
        app.router.add_get("/api/stats/api-calls", self._api_stats_api_calls)
        app.router.add_get("/api/stats/active-users", self._api_stats_active_users)
        app.router.add_get("/api/_debug/status", self._api_debug_status)
        # 插件管理
        app.router.add_get("/api/plugins/check-updates", self._api_plugins_check_updates)
        app.router.add_post("/api/plugins/install", self._api_plugins_install)
        app.router.add_post("/api/plugins/{name}/uninstall", self._api_plugins_uninstall)
        app.router.add_post("/api/plugins/{name}/toggle", self._api_plugins_toggle)
        app.router.add_post("/api/plugins/{name}/update", self._api_plugins_update)

        self._app = app
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._port)

        try:
            await self._site.start()
        except OSError as e:
            # 端口被占
            adapter_port = os.getenv("NEO_BOT_ADAPTER_PORT", "(未设置)")
            self.ctx.logger.error(
                f"Dashboard 启动失败: 端口 {self._host}:{self._port} 被占用 ({e}). "
                f"NeoBot 反向 WS 监听 NEO_BOT_ADAPTER_PORT={adapter_port},与 Dashboard 不能相同。"
                f"请编辑 plugins/dashboard/plugin.toml 把 port 改成其他空闲端口。"
            )
            try:
                await self._runner.cleanup()
            except Exception:
                pass
            self._site = None
            self._runner = None
            self._app = None
            return

        # 打印token
        url = f"http://{self._host}:{self._port}/"
        if self._token_source == "auto":
            origin_hint = (
                f"已生成"
            )
        elif self._token_source == "file":
            origin_hint = f"(从 {self._token_file} 加载)"
        else:
            origin_hint = "(来自 plugin.toml)"

        banner = (
            "\n"
            "\n"
            "NeoBot Dashboard 已启动"
            f"访问地址: {url:<50s}\n"
            f"Access Token: \n"
            f"{self._token}\n"
            "\n"
        )
        self.ctx.logger.info(banner)

        self._latency_task = asyncio.create_task(self._latency_loop())

    async def _latency_loop(self) -> None:
        await asyncio.sleep(5)
        try:
            from neobot_adapter.request.system import get_status
        except ImportError:
            self.ctx.logger.debug("Latency loop: 无法导入 get_status,跳过")
            return

        while True:
            try:
                t0 = time.perf_counter()
                try:
                    await asyncio.wait_for(get_status(timeout=8), timeout=10)
                    rtt = int((time.perf_counter() - t0) * 1000)
                    self._latency_ms = rtt
                    self._latency_at = time.time()
                    self._latency_history.append((self._latency_at, rtt))
                except (asyncio.TimeoutError, Exception) as e:
                    self._latency_ms = None
                    self._latency_history.append((time.time(), None))
                    self.ctx.logger.debug(f"Latency ping 失败: {e}")
            except asyncio.CancelledError:
                break
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                break

    async def on_stop(self) -> None:
        if self._latency_task is not None and not self._latency_task.done():
            self._latency_task.cancel()
            try:
                await self._latency_task
            except (asyncio.CancelledError, Exception):
                pass
        self._latency_task = None

        # 关web
        try:
            if self._site is not None:
                await self._site.stop()
        except Exception:
            pass
        try:
            if self._runner is not None:
                await self._runner.cleanup()
        except Exception:
            pass
        self._site = None
        self._runner = None
        self._app = None

        if self._log_sink_id is not None:
            try:
                _loguru_logger.remove(self._log_sink_id)
            except Exception:
                pass
            self._log_sink_id = None

        self._save_stats()

    # 首页
    async def _handle_index(self, request: web.Request) -> web.StreamResponse:
        return await self._serve_html_with_version("index.html")

    async def _handle_login_page(self, request: web.Request) -> web.StreamResponse:
        return await self._serve_html_with_version("login.html")

    async def _handle_favicon(self, request: web.Request) -> web.StreamResponse:
        favicon_path = self.ctx.plugin_dir / "web" / "image" / "icon.webp"

        if favicon_path.exists():
            resp = web.FileResponse(favicon_path)
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            return resp

        return web.Response(status=404, text="favicon not found")

    async def _serve_html_with_version(self, filename: str) -> web.StreamResponse:
        html_path = self.ctx.plugin_dir / "web" / filename
        if not html_path.exists():
            return web.Response(status=500, text=f"web/{filename} 不存在")
        try:
            content = html_path.read_text(encoding="utf-8")
            ver = str(self._asset_version)

            content = re.sub(
                r'((?:href|src)=")(\./[^"]+\.(?:js|css|html))"',
                lambda m: f'{m.group(1)}{m.group(2)}?v={ver}"',
                content,
            )
            js_dir = self.ctx.plugin_dir / "web" / "js"
            if js_dir.exists():
                imports: dict[str, str] = {}
                for js_file in js_dir.rglob("*.js"):
                    try:
                        rel = js_file.relative_to(self.ctx.plugin_dir / "web").as_posix()
                    except ValueError:
                        continue
                    bare = f"./{rel}"
                    versioned = f"{bare}?v={ver}"
                    imports[bare] = versioned
                if imports:
                    importmap_json = json.dumps({"imports": imports}, ensure_ascii=False)
                    importmap_tag = (
                        f'<script type="importmap">{importmap_json}</script>'
                    )
                    if "</head>" in content:
                        content = content.replace("</head>", importmap_tag + "\n</head>", 1)
                    else:
                        content = importmap_tag + "\n" + content

            resp = web.Response(text=content, content_type="text/html", charset="utf-8")
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            return resp
        except Exception as e:
            self.ctx.logger.exception(f"渲染 {filename} 失败: {e}")
            return web.Response(status=500, text=str(e))

    def _get_client_ip(self, request: web.Request) -> str:
        # 获取客户端IP。
        if request.transport is None:
            return "unknown"

        peername = request.transport.get_extra_info("peername")
        if not peername:
            return "unknown"

        return str(peername[0])


    def _check_login_rate_limit(self, ip: str) -> tuple[bool, int]:
        # IP是否已经触发登录限速。
        now = time.time()

        # 取出该IP的失败记录
        failures = self._login_failures.setdefault(ip, collections.deque())

        # 清理时间窗口以外的旧失败记录
        while failures and now - failures[0] > self._login_rate_limit_window:
            failures.popleft()

        # 如果失败次数达到上限，则拒绝继续登录
        if len(failures) >= self._login_max_failures:
            retry_after = int(self._login_rate_limit_window - (now - failures[0]))
            retry_after = max(1, retry_after)
            return False, retry_after

        return True, 0


    def _record_login_failure(self, ip: str) -> None:
        # 记录IP的登录。
        failures = self._login_failures.setdefault(ip, collections.deque())
        failures.append(time.time())


    def _clear_login_failures(self, ip: str) -> None:
        #登录成功后清空该IP的失败记录。
        self._login_failures.pop(ip, None)
    async def _api_auth_login(self, request: web.Request) -> web.Response:
        if not self._token:
            return web.json_response({
                "error": "服务端未设置 access_token,无需登录。请在 plugin.toml 配置后重启。"
            }, status=400)

        ip = self._get_client_ip(request)

        #检查这个IP是否已经被限制
        allowed, retry_after = self._check_login_rate_limit(ip)
        if not allowed:
            return web.json_response({
                "error": f"登录失败次数过多，请 {retry_after} 秒后再试",
                "retry_after": retry_after,
            }, status=429, headers={
                "Retry-After": str(retry_after)
            })

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "请求体不是合法 JSON"}, status=400)

        provided = (data.get("access_token") or "").strip()
        if not provided:
            return web.json_response({"error": "缺少 access_token"}, status=400)

        # 使用 hmac.compare_digest 避免字符串比较时产生细微时间差
        if not hmac.compare_digest(provided, self._token):
            self._record_login_failure(ip)

            # 记录失败后，再检查一次是否刚好达到限制
            allowed, retry_after = self._check_login_rate_limit(ip)

            if not allowed:
                self.ctx.logger.warning(
                    f"Dashboard 登录失败次数过多，已临时限制: ip={ip}, retry_after={retry_after}s"
                )
                return web.json_response({
                    "error": f"Token 错误次数过多，请 {retry_after} 秒后再试",
                    "retry_after": retry_after,
                }, status=429, headers={
                    "Retry-After": str(retry_after)
                })

            return web.json_response({"error": "Token 错误"}, status=401)

        # 登录成功
        self._clear_login_failures(ip)

        # 新设备token
        new_token = uuid.uuid4().hex + uuid.uuid4().hex   # 64 个十六进制字符
        ua = request.headers.get("User-Agent", "")[:200]

        async with (self._device_tokens_lock or asyncio.Lock()):
            self._device_tokens[new_token] = {
                "created_at": time.time(),
                "ua": ua,
                "ip": ip,
            }
            self._save_device_tokens()

        self.ctx.logger.info(f"新设备登录: ip={ip} ua={ua[:60]!r}")

        return web.json_response({"ok": True, "token": new_token})

    async def _api_auth_logout(self, request: web.Request) -> web.Response:
        tk = request.headers.get("X-Token") or request.query.get("token") or ""
        if not tk:
            return web.json_response({"ok": True})
        async with (self._device_tokens_lock or asyncio.Lock()):
            removed = self._device_tokens.pop(tk, None)
            if removed is not None:
                self._save_device_tokens()
        return web.json_response({"ok": True})

    async def _api_auth_me(self, request: web.Request) -> web.Response:
        tk = request.headers.get("X-Token") or request.query.get("token") or ""
        if tk == self._token and self._token:
            return web.json_response({"ok": True, "kind": "access_token"})
        info = self._device_tokens.get(tk)
        if info is not None:
            return web.json_response({
                "ok": True, "kind": "device_token",
                "created_at": info.get("created_at"),
                "ua": info.get("ua", "")[:200],
            })
        return web.json_response({"error": "unauthorized"}, status=401)

    async def _api_auth_devices(self, request: web.Request) -> web.Response:
        items = [
            {"token_preview": t[:8] + "…" + t[-4:],
             "token": t,
             "created_at": v.get("created_at"),
             "ua": v.get("ua", ""),
             "ip": v.get("ip", "")}
            for t, v in self._device_tokens.items()
        ]
        items.sort(key=lambda x: x["created_at"] or 0, reverse=True)
        return web.json_response({"items": items, "count": len(items)})

    async def _api_auth_devices_revoke(self, request: web.Request) -> web.Response:
        cur = request.headers.get("X-Token") or request.query.get("token") or ""
        try:
            data = await request.json()
        except Exception:
            data = {}
        async with (self._device_tokens_lock or asyncio.Lock()):
            if data.get("all"):
                #全部撤销但保留发起请求的当前设备
                kept = self._device_tokens.get(cur)
                self._device_tokens.clear()
                if kept is not None:
                    self._device_tokens[cur] = kept
            else:
                target = (data.get("token") or "").strip()
                if not target:
                    return web.json_response({"error": "缺少 token 参数"}, status=400)
                self._device_tokens.pop(target, None)
            self._save_device_tokens()
        return web.json_response({"ok": True, "remaining": len(self._device_tokens)})

    def _load_device_tokens(self) -> None:
        if not self._device_tokens_path or not self._device_tokens_path.exists():
            self._device_tokens = {}
            return
        try:
            with open(self._device_tokens_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("tokens"), dict):
                self._device_tokens = data["tokens"]
            elif isinstance(data, dict):
                self._device_tokens = data
            else:
                self._device_tokens = {}
        except Exception:
            self._device_tokens = {}

    def _save_device_tokens(self) -> None:
        if not self._device_tokens_path:
            return
        try:
            tmp = self._device_tokens_path.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"tokens": self._device_tokens}, f, ensure_ascii=False)
            os.replace(tmp, self._device_tokens_path)
        except Exception as e:
            self.ctx.logger.debug(f"保存 device_tokens.json 失败: {e}")

    # API
    async def _api_overview(self, request: web.Request) -> web.Response:
        bot = await self._get_bot_info_cached()
        plugin_count = self._count_plugins()
        async with self._stats_lock:
            stats = dict(self._stats)
        return web.json_response({
            "uptime_seconds": time.time() - _PROCESS_STARTED_AT,
            "bot_user_id": bot.get("user_id"),
            "bot_nickname": bot.get("nickname") or "(未连接)",
            "app_name": bot.get("app_name") or "—",
            "app_version": bot.get("app_version") or "—",
            "protocol_version": bot.get("protocol_version") or "—",
            "today_messages": stats.get("today", 0),
            "total_messages": stats.get("total", 0),
            "plugins_loaded": plugin_count["loaded"],
            "plugins_total": plugin_count["total"],
            "online": bot.get("user_id") is not None,
        })
    async def _api_bots(self, request: web.Request) -> web.Response:
        bot = await self._get_bot_info_cached()
        async with self._stats_lock:
            stats = dict(self._stats)
        online = bot.get("user_id") is not None
        latency = self._latency_ms
        return web.json_response([
            {
                "name": bot.get("nickname") or "NeoBot",
                "user_id": bot.get("user_id"),
                "platform": f"onebot · {bot.get('app_name') or '—'}",
                "status": "on" if online else "off",
                "message_count": stats.get("total", 0),
                "latency_ms": round(latency, 1) if latency is not None else None,
                "latency_age_sec": int(time.time() - self._latency_at) if self._latency_at else None,
                "avatar_initial": (bot.get("nickname") or "N")[:1].upper(),
                "avatar_url": (
                    f"https://q1.qlogo.cn/g?b=qq&nk={bot.get('user_id')}&s=100"
                    if bot.get("user_id") else None
                ),
            }
        ])
    async def _api_plugins(self, request: web.Request) -> web.Response:
        return web.json_response({
            "items": self._scan_plugins(),
            "root": str(self.ctx.plugin_dir.parent),
        })
    async def _api_logs(self, request: web.Request) -> web.Response:
        max_buf = self._log_buffer.maxlen or 2000
        try:
            limit = int(request.query.get("limit", "100"))
        except ValueError:
            limit = 100
        limit = max(1, min(limit, max_buf))

        since_raw = request.query.get("since")
        try:
            since = int(since_raw) if since_raw else None
        except ValueError:
            since = None

        snapshot = list(self._log_buffer)
        if since is not None:
            items = [it for it in snapshot if it.get("id", 0) > since]
            if len(items) > limit:
                items = items[-limit:]
        else:
            items = snapshot[-limit:]

        last_id = snapshot[-1]["id"] if snapshot else 0
        return web.json_response({
            "items": items,
            "last_id": last_id,
            "total": len(snapshot),
        })
    async def _api_series_messages(self, request: web.Request) -> web.Response:
        try:
            days = int(request.query.get("days", str(self._history_max_days)))
        except ValueError:
            days = self._history_max_days
        days = max(1, min(days, self._history_max_days))

        async with self._stats_lock:
            hist = list(self._stats.get("history") or [])
            today_date = self._stats.get("today_date") or datetime.now().strftime("%Y-%m-%d")
            today_count = int(self._stats.get("today", 0))
        series = hist[-(days - 1):] if days > 1 else []
        series.append({"date": today_date, "count": today_count})

        return web.json_response({
            "series": series,
            "days": days,
            "today": today_date,
        })

    async def _api_series_latency(self, request: web.Request) -> web.Response:
        items = [
            {"ts": ts, "ms": ms}
            for (ts, ms) in self._latency_history
        ]
        #统计
        success = [m for (_, m) in self._latency_history if m is not None]
        avg = round(sum(success) / len(success), 1) if success else None
        return web.json_response({
            "series": items,
            "current_ms": self._latency_ms,
            "avg_ms": avg,
            "samples": len(items),
            "success_rate": round(len(success) / len(items) * 100, 1) if items else None,
        })

    async def _api_stats_api_calls(self, request: web.Request) -> web.Response:
        try:
            limit = int(request.query.get("limit", "10"))
        except ValueError:
            limit = 10
        limit = max(1, min(limit, 50))
        total = sum(self._api_call_counts.values())
        items = sorted(self._api_call_counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        return web.json_response({
            "items": [{"action": a, "count": c} for a, c in items],
            "total_calls": total,
            "unique_actions": len(self._api_call_counts),
        })

    async def _api_stats_active_users(self, request: web.Request) -> web.Response:
        try:
            limit = int(request.query.get("limit", "10"))
        except ValueError:
            limit = 10
        limit = max(1, min(limit, 50))
        try:
            since_hours = float(request.query.get("since_hours", "0"))
        except ValueError:
            since_hours = 0
        cutoff = time.time() - since_hours * 3600 if since_hours > 0 else 0

        async with self._stats_lock:
            snapshot = list(self._user_activity.items())
        items = [
            (uid, rec) for (uid, rec) in snapshot
            if rec.get("last_seen", 0) >= cutoff
        ]
        items.sort(key=lambda kv: kv[1].get("count", 0), reverse=True)
        items = items[:limit]
        return web.json_response({
            "items": [
                {
                    "user_id": uid,
                    "count": rec.get("count", 0),
                    "last_seen": rec.get("last_seen", 0),
                    "nickname": rec.get("nickname", "") or f"用户{uid}",
                }
                for uid, rec in items
            ],
            "tracked_users": len(snapshot),
        })

    async def _api_bot_detail(self, request: web.Request) -> web.Response:
        bot = await self._get_bot_info_cached()
        async with self._stats_lock:
            stats = dict(self._stats)
        online = bot.get("user_id") is not None
        return web.json_response({
            "user_id":      bot.get("user_id"),
            "nickname":     bot.get("nickname"),
            "online":       online,
            "app_name":     bot.get("app_name"),
            "app_version":  bot.get("app_version"),
            "protocol_version": bot.get("protocol_version"),
            "latency_ms":   self._latency_ms,
            "latency_age_sec": int(time.time() - self._latency_at) if self._latency_at else None,
            "uptime_seconds": time.time() - _PROCESS_STARTED_AT,
            "today_messages": stats.get("today", 0),
            "total_messages": stats.get("total", 0),
            "avatar_url":   (
                f"https://q1.qlogo.cn/g?b=qq&nk={bot.get('user_id')}&s=640"
                if bot.get("user_id") else None
            ),
        })

    # 插件管理
    def _require_manage(self) -> tuple[bool, str]:
        if not self._token:
            return False,
        return True, ""

    @staticmethod
    def _find_runtime(ctx: Any) -> Any | None:
        
        rec_sub = getattr(getattr(ctx, "on", None), "_record_subscription", None)
        if not callable(rec_sub):
            return None
        closure = getattr(rec_sub, "__closure__", None)
        if not closure:
            return None
        freevars = getattr(getattr(rec_sub, "__code__", None), "co_freevars", ())
        if "self" in freevars:
            idx = freevars.index("self")
            obj = closure[idx].cell_contents
            if hasattr(obj, "manager") and hasattr(obj, "loader"):
                return obj
        # 退化路径
        for cell in closure:
            try:
                obj = cell.cell_contents
            except ValueError:
                continue
            if hasattr(obj, "manager") and hasattr(obj, "loader"):
                return obj
        return None

    async def _hot_unload(self, name: str) -> bool:
        if self._runtime is None:
            return False
        manager = self._runtime.manager
        records = getattr(manager, "_records", None) or {}
        if name not in records:
            return False
        plugin_dir = records[name].context.plugin_dir
        await manager.stop_plugin(name)
        records.pop(name, None)
        prefix = "neobot_user_plugins."
        try:
            pd_resolved = str(plugin_dir.resolve()) if plugin_dir.exists() else ""
        except OSError:
            pd_resolved = ""
        if pd_resolved:
            for mn, m in list(sys.modules.items()):
                if not mn.startswith(prefix):
                    continue
                mf = getattr(m, "__file__", None)
                if not mf:
                    continue
                try:
                    if pd_resolved in str(Path(mf).resolve()):
                        sys.modules.pop(mn, None)
                except OSError:
                    pass
        # 清pycache
        if plugin_dir.is_dir():
            for pc in plugin_dir.rglob("__pycache__"):
                shutil.rmtree(pc, ignore_errors=True)
        importlib.invalidate_caches()
        self.ctx.logger.info(f"hot_unload: {name} 已卸载")
        return True

    async def _hot_load(self, plugin_dir: Path) -> tuple[bool, str]:
        """加载位于 plugin_dir 的插件。返回 (success, name_or_error)。"""
        if self._runtime is None:
            return False, "runtime 未就绪"
        try:
            from neobot_modloader.loader import PluginLoadError
        except ImportError:
            return False, "modloader 内部接口缺失"
        runtime = self._runtime
        loader = runtime.loader
        manager = runtime.manager
        # 清pycache
        if plugin_dir.is_dir():
            for pc in plugin_dir.rglob("__pycache__"):
                shutil.rmtree(pc, ignore_errors=True)
        importlib.invalidate_caches()
        # 加载
        try:
            if plugin_dir.is_dir() and (plugin_dir / "__init__.py").is_file():
                result = loader._load_package(plugin_dir)
            elif plugin_dir.is_file() and plugin_dir.suffix == ".py":
                result = loader._load_file(plugin_dir)
            else:
                return False, f"目标既不是包目录也不是 .py 文件: {plugin_dir}"
            if isinstance(result, PluginLoadError):
                return False, f"加载失败: {result.error}"
            # 同名已注册:先卸载
            if result.name in manager._records:
                await self._hot_unload(result.name)
            runtime._register(result)
            await manager.load_plugin(result.name)
            await manager.start_plugin(result.name)
            self.ctx.logger.info(f"hot_load: {result.name} 加载完成")
            return True, result.name
        except Exception as e:
            self.ctx.logger.exception(f"hot_load 异常: {e}")
            return False, str(e)

    def _hot_supported(self) -> bool:
        return self._runtime is not None


    @staticmethod
    def _parse_repo(spec: str) -> tuple[str, str] | None:
        if not spec:
            return None
        spec = spec.strip()
        m = re.match(r"^(?:https?://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", spec)
        if not m:
            return None
        return m.group(1), m.group(2)

    def _resolve_plugin_path(self, name: str) -> tuple[Path, bool] | None:
        # 路径越界防护
        if not name or "/" in name or "\\" in name or ".." in name or name.startswith("."):
            return None
        root = self.ctx.plugin_dir.parent
        enabled = root / name
        disabled = root / f"_{name}"
        if enabled.exists():
            return enabled, False
        if disabled.exists():
            return disabled, True
        return None

    async def _fetch_remote_toml(self, owner: str, repo: str, branch: str) -> dict | None:
        #从GitHub拉plugin.toml
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/plugin.toml"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(url) as r:
                    if r.status != 200:
                        return None
                    text = await r.text()
                    return tomllib.loads(text)
        except Exception as e:
            self.ctx.logger.debug(f"拉取 {url} 失败: {e}")
            return None

    async def _download_zip(self, owner: str, repo: str, branch: str, dest: Path) -> bool:
        url = f"https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip"
        try:
            timeout = aiohttp.ClientTimeout(total=60, connect=10)
            async with aiohttp.ClientSession(timeout=timeout) as s:
                async with s.get(url) as r:
                    if r.status != 200:
                        self.ctx.logger.warning(f"下载 zip 失败 status={r.status} url={url}")
                        return False
                    with open(dest, "wb") as f:
                        async for chunk in r.content.iter_chunked(8192):
                            f.write(chunk)
                    return True
        except Exception as e:
            self.ctx.logger.exception(f"下载 zip 异常: {e}")
            return False

    async def _install_from_github(self, owner: str, repo: str, branch: str,
                                   target_name: str | None = None) -> tuple[bool, str]:
        plugins_root = self.ctx.plugin_dir.parent

        with tempfile.TemporaryDirectory(prefix="neobot-plg-") as tmp:
            tmp_dir = Path(tmp)
            zip_path = tmp_dir / "src.zip"
            if not await self._download_zip(owner, repo, branch, zip_path):
                return False, f"无法从 GitHub 下载 {owner}/{repo}@{branch}.zip"

            # 解压
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(tmp_dir / "extracted")
            except zipfile.BadZipFile:
                return False, "下载到的内容不是合法 zip(仓库可能不存在或分支错误)"
            extracted = tmp_dir / "extracted"
            roots = [p for p in extracted.iterdir() if p.is_dir()]
            if not roots:
                return False, "zip 内没有任何目录"
            src_root = roots[0]

            # 验证plugin.toml,__init__.py
            has_toml = (src_root / "plugin.toml").exists()
            has_init = (src_root / "__init__.py").exists()
            if not (has_toml or has_init):
                return False, "仓库根目录里没有 plugin.toml 或 __init__.py,不像是 NeoBot 插件"

            # 决定目标名
            if target_name:
                final_name = target_name
            elif has_toml:
                try:
                    with open(src_root / "plugin.toml", "rb") as f:
                        meta = tomllib.load(f)
                    final_name = str(meta.get("name") or repo)
                except Exception:
                    final_name = repo
            else:
                final_name = repo

            # 名字安全检查
            if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$", final_name):
                return False, f"插件名 '{final_name}' 含非法字符"

            target = plugins_root / final_name
            # 路径越界防护
            try:
                target.resolve().relative_to(plugins_root.resolve())
            except ValueError:
                return False, "目标路径越界,拒绝写入"

            if target.exists():
                return False, f"插件目录 {final_name} 已存在,请先卸载或更新现有版本"

            # 复制到目标
            shutil.copytree(src_root, target)
            return True, f"插件 {final_name} 已安装到 plugins/{final_name},重启 NeoBot 后生效"

    async def _api_plugins_install(self, request: web.Request) -> web.Response:
        ok, why = self._require_manage()
        if not ok:
            return web.json_response({"error": why}, status=403)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "请求体不是合法 JSON"}, status=400)
        repo_spec = body.get("repo", "")
        branch = body.get("branch") or "main"
        parsed = self._parse_repo(repo_spec)
        if not parsed:
            return web.json_response({"error": f"无法解析仓库:{repo_spec}"}, status=400)
        owner, repo = parsed
        async with self._hot_reload_lock:
            success, msg = await self._install_from_github(owner, repo, branch)
            if not success:
                return web.json_response({"ok": False, "message": msg}, status=400)
            # 安装成功后,尝试热加载
            if self._hot_supported():
                new_path = self.ctx.plugin_dir / repo
                if new_path.exists():
                    ok2, info = await self._hot_load(new_path)
                    if ok2:
                        msg = f"{msg} 并已加载({info})"
                    else:
                        msg = f"{msg};但热加载失败({info}),重启 NeoBot 后生效"
        return web.json_response({"ok": True, "message": msg}, status=200)

    async def _api_plugins_uninstall(self, request: web.Request) -> web.Response:
        ok, why = self._require_manage()
        if not ok:
            return web.json_response({"error": why}, status=403)
        name = request.match_info["name"]
        if name == self.name:
            return web.json_response({"error": "不允许卸载 dashboard 自身"}, status=400)
        resolved = self._resolve_plugin_path(name)
        if not resolved:
            return web.json_response({"error": f"插件 {name} 不存在"}, status=404)
        path, _ = resolved
        try:
            path.resolve().relative_to(self.ctx.plugin_dir.parent.resolve())
        except ValueError:
            return web.json_response({"error": "路径越界,拒绝删除"}, status=400)
        async with self._hot_reload_lock:
            hot_done = await self._hot_unload(name)
            try:
                shutil.rmtree(path)
            except Exception as e:
                return web.json_response({"error": f"删除失败: {e}"}, status=500)
            self._update_cache.pop(name, None)
        msg = (f"插件 {name} 已卸载并停止"
               if hot_done else f"插件 {name} 已卸载,重启 NeoBot 后停止加载")
        return web.json_response({"ok": True, "message": msg})

    async def _api_plugins_toggle(self, request: web.Request) -> web.Response:
        ok, why = self._require_manage()
        if not ok:
            return web.json_response({"error": why}, status=403)
        name = request.match_info["name"]
        if name == self.name:
            return web.json_response({"error": "不允许禁用 dashboard 自身"}, status=400)
        resolved = self._resolve_plugin_path(name)
        if not resolved:
            return web.json_response({"error": f"插件 {name} 不存在"}, status=404)
        path, is_disabled = resolved
        root = self.ctx.plugin_dir.parent
        async with self._hot_reload_lock:
            try:
                if is_disabled:
                    target = root / name
                    os.rename(path, target)
                    hot_msg = ""
                    if self._hot_supported():
                        ok2, info = await self._hot_load(target)
                    else:
                        hot_msg = "已重命名,重启 NeoBot 后加载"
                    return web.json_response({
                        "ok": True, "enabled": True,
                        "message": f"插件 {name} 已启用",
                    })
                else:
                    hot_done = await self._hot_unload(name)
                    target = root / f"_{name}"
                    os.rename(path, target)
                    return web.json_response({
                        "ok": True, "enabled": False,
                        "message": f"插件 {name} 已禁用",
                    })
            except OSError as e:
                return web.json_response({"error": f"重命名失败: {e}"}, status=500)

    async def _api_plugins_update(self, request: web.Request) -> web.Response:
        ok, why = self._require_manage()
        if not ok:
            return web.json_response({"error": why}, status=403)
        name = request.match_info["name"]
        resolved = self._resolve_plugin_path(name)
        if not resolved:
            return web.json_response({"error": f"插件 {name} 不存在"}, status=404)
        path, _ = resolved
        # 读repo/branch
        toml_path = path / "plugin.toml"
        if not toml_path.exists():
            return web.json_response({"error": "插件没有 plugin.toml,无法确定 repo"}, status=400)
        try:
            with open(toml_path, "rb") as f:
                meta = tomllib.load(f)
        except Exception as e:
            return web.json_response({"error": f"plugin.toml 解析失败: {e}"}, status=400)
        repo_spec = str(meta.get("repo") or "")
        if not repo_spec:
            return web.json_response({"error": "plugin.toml 里没有 repo 字段,无法自动更新"}, status=400)
        parsed = self._parse_repo(repo_spec)
        if not parsed:
            return web.json_response({"error": f"无法解析 repo: {repo_spec}"}, status=400)
        owner, repo = parsed
        branch = str(meta.get("branch") or "main")

        async with self._hot_reload_lock:
            await self._hot_unload(name)

            # 备份+下新zip
            plugins_root = self.ctx.plugin_dir.parent
            backup = plugins_root / f".{path.name}.backup.{int(time.time())}"
            try:
                os.rename(path, backup)
            except OSError as e:
                return web.json_response({"error": f"备份原目录失败: {e}"}, status=500)

            try:
                success, msg = await self._install_from_github(owner, repo, branch, target_name=name)
                if not success:
                    if path.exists():
                        shutil.rmtree(path, ignore_errors=True)
                    os.rename(backup, path)
                    # 回滚后尝试把旧版重新热重载
                    if self._hot_supported():
                        await self._hot_load(path)
                    return web.json_response({"error": f"更新失败已回滚: {msg}"}, status=500)
                shutil.rmtree(backup, ignore_errors=True)
                self._update_cache.pop(name, None)

                # 加载新版
                hot_msg = ""
                if self._hot_supported():
                    new_path = path if path.exists() else self.ctx.plugin_dir / name
                    ok2, info = await self._hot_load(new_path)
                    hot_msg = "已立即生效" if ok2 else f"热加载失败({info}),重启后生效"
                else:
                    hot_msg = "重启 NeoBot 后生效"
                return web.json_response({
                    "ok": True,
                    "message": f"插件 {name} 已更新,{hot_msg}",
                })
            except Exception as e:
                if not path.exists() and backup.exists():
                    os.rename(backup, path)
                    if self._hot_supported():
                        await self._hot_load(path)
                return web.json_response({"error": f"更新异常: {e}"}, status=500)

    async def _api_plugins_check_updates(self, request: web.Request) -> web.Response:
        """触发一次远程版本检查;有 force=1 时忽略缓存。返回当前所有插件的更新信息。"""
        force = request.query.get("force") == "1"
        scanned = self._scan_plugins()
        now = time.time()
        # 并发拉取所有有repo字段的插件
        async def check_one(item):
            name = item["name"]
            repo_spec = item.get("repo") or ""
            branch = item.get("branch") or "main"
            if not repo_spec:
                return name, None
            cached = self._update_cache.get(name)
            if (not force) and cached and (now - cached[0]) < self._update_cache_ttl:
                return name, cached[1]
            parsed = self._parse_repo(repo_spec)
            if not parsed:
                return name, None
            owner, repo = parsed
            meta = await self._fetch_remote_toml(owner, repo, branch)
            ver = str(meta.get("version")) if meta and meta.get("version") else None
            self._update_cache[name] = (now, ver)
            return name, ver

        results = await asyncio.gather(*(check_one(it) for it in scanned), return_exceptions=True)
        out: dict[str, Any] = {}
        for r in results:
            if isinstance(r, Exception):
                continue
            name, ver = r
            out[name] = ver
        return web.json_response({"remote_versions": out, "force": force})

    # debug
    async def _api_debug_status(self, request: web.Request) -> web.Response:
        return web.json_response({
            "plugin_version": self.version,
            "log_sink_registered": self._log_sink_id is not None,
            "log_sink_id": self._log_sink_id,
            "log_sink_calls": getattr(self, "_log_sink_calls", -1),
            "log_buffer_size": len(self._log_buffer),
            "log_buffer_maxlen": self._log_buffer.maxlen,
            "last_log_seq": self._log_seq,
            "api_call_counts": dict(self._api_call_counts),
            "user_activity_size": len(self._user_activity),
            "latency_history_size": len(self._latency_history),
            "latency_ms_current": self._latency_ms,
            "manage_plugins_enabled": self._manage_plugins,
            "has_access_token": bool(self._token),
        })

    # 系统信息
    async def _api_system(self, request: web.Request) -> web.Response:
        #CPU
        cpu_pct: float | None = None
        now_sample = _read_cpu_jiffies()
        if now_sample and self._last_cpu_sample:
            i1, t1 = self._last_cpu_sample
            i2, t2 = now_sample
            dt = t2 - t1
            di = i2 - i1
            if dt > 0:
                cpu_pct = max(0.0, min(100.0, (1.0 - di / dt) * 100.0))
        if now_sample:
            self._last_cpu_sample = now_sample

        mem = _read_mem_info()
        #磁盘
        try:
            data_root = (self.ctx.data_dir).resolve()
            du = shutil.disk_usage(str(data_root))
            disk_used_gb = (du.total - du.free) / (1024 ** 3)
            disk_total_gb = du.total / (1024 ** 3)
            disk_pct = (du.total - du.free) / du.total * 100.0 if du.total else 0.0
        except Exception:
            disk_used_gb = disk_total_gb = disk_pct = None  # type: ignore[assignment]

        return web.json_response({
            "cpu_percent": cpu_pct,
            "mem_used_mb": mem[0] if mem else None,
            "mem_total_mb": mem[1] if mem else None,
            "mem_percent": (mem[0] / mem[1] * 100.0) if mem else None,
            "disk_used_gb": disk_used_gb,
            "disk_total_gb": disk_total_gb,
            "disk_percent": disk_pct,
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.machine()}",
            "python_version": platform.python_version(),
            "started_at": datetime.fromtimestamp(_PROCESS_STARTED_AT).strftime("%Y-%m-%d %H:%M:%S"),
        })

    # Bot信息
    async def _get_bot_info_cached(self) -> dict[str, Any]:
        now = time.time()
        if (now - self._bot_info_cache_at) < self._bot_info_ttl and self._bot_info_cache:
            return self._bot_info_cache

        if self._bot_info_lock is None:
            return self._bot_info_cache or {}

        async with self._bot_info_lock:
            now2 = time.time()
            if (now2 - self._bot_info_cache_at) < self._bot_info_ttl and self._bot_info_cache:
                return self._bot_info_cache

            info: dict[str, Any] = {}
            try:
                from neobot_adapter.request.system import get_login_info, get_version_info

                async def _both():
                    login_task = asyncio.create_task(get_login_info(timeout=8))
                    ver_task = asyncio.create_task(get_version_info(timeout=8))
                    login, ver = await asyncio.gather(login_task, ver_task, return_exceptions=True)
                    return login, ver

                t0 = time.monotonic()
                login, ver = await asyncio.wait_for(_both(), timeout=12)
                elapsed_ms = (time.monotonic() - t0) * 1000.0

                if not isinstance(login, Exception):
                    ld = getattr(login, "data", None)
                    if ld is not None:
                        info["user_id"] = getattr(ld, "user_id", None)
                        info["nickname"] = getattr(ld, "nickname", None)
                if not isinstance(ver, Exception):
                    vd = getattr(ver, "data", None)
                    if vd is not None:
                        info["app_name"] = getattr(vd, "app_name", None)
                        info["app_version"] = getattr(vd, "app_version", None)
                        info["protocol_version"] = getattr(vd, "protocol_version", None)
                if not (isinstance(login, Exception) and isinstance(ver, Exception)):
                    self._latency_ms = elapsed_ms
                    self._latency_at = time.time()
            except (asyncio.TimeoutError, RuntimeError, Exception) as e:
                self.ctx.logger.debug(f"Bot 信息查询失败: {e}")

            self._bot_info_cache = info
            self._bot_info_cache_at = time.time()
            return info

    # 扫描插件目录
    def _scan_plugins(self) -> list[dict[str, Any]]:
        plugins_root = self.ctx.plugin_dir.parent
        items: list[dict[str, Any]] = []
        try:
            entries = sorted(plugins_root.iterdir(), key=lambda p: p.name.lower())
        except (FileNotFoundError, NotADirectoryError):
            return items
        for entry in entries:
            if entry.name.startswith(".") or entry.name == "__pycache__":
                continue
            is_disabled = entry.name.startswith("_")
            real_name = entry.name[1:] if is_disabled else entry.name
            if not real_name:
                continue

            name = real_name
            version = "—"
            description = ""
            author = ""
            repo = ""
            branch = "main"
            status = "disabled" if is_disabled else "loaded"
            kind = "module"
            has_toml = False

            if entry.is_dir():
                kind = "package"
                toml_path = entry / "plugin.toml"
                if toml_path.exists():
                    has_toml = True
                    try:
                        with open(toml_path, "rb") as f:
                            data = tomllib.load(f)
                        name = str(data.get("name") or real_name)
                        version = str(data.get("version") or version)
                        description = str(data.get("description") or "")
                        author = str(data.get("author") or "")
                        # 检查更新
                        repo = str(data.get("repo") or "")
                        branch = str(data.get("branch") or "main")
                    except Exception as e:
                        status = "error"
                        description = f"plugin.toml 解析失败: {e}"
                elif not (entry / "__init__.py").exists():
                    continue
            elif entry.is_file() and entry.suffix == ".py":
                kind = "single-file"
            else:
                continue

            try:
                if entry.is_dir():
                    size = sum(p.stat().st_size for p in entry.rglob("*") if p.is_file())
                else:
                    size = entry.stat().st_size
            except OSError:
                size = 0
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                mtime = 0.0

            # 更新信息
            cached = self._update_cache.get(name)
            remote_version = cached[1] if cached else None
            update_status = self._update_status(version, remote_version)

            items.append({
                "name": name,
                "version": version,
                "description": description,
                "author": author,
                "status": status,
                "kind": kind,
                "has_manifest": has_toml,
                "path": entry.name,
                "size_bytes": size,
                "mtime": mtime,
                "repo": repo,
                "branch": branch,
                "remote_version": remote_version,
                "update_status": update_status,
                "manageable": self._is_manageable(name),
            })
        return items

    @staticmethod
    def _update_status(local: str, remote: str | None) -> str:
        if not remote:
            return "unknown"
        try:
            la = [int(x) for x in str(local).split(".")]
            ra = [int(x) for x in str(remote).split(".")]
            if la < ra: return "available"
            if la > ra: return "ahead"
            return "latest"
        except (ValueError, AttributeError):
            if local == remote: return "latest"
            return "available" if local < remote else "ahead"

    def _is_manageable(self, name: str) -> bool:
        # dashboard自身不能被直接卸载/禁用,不然会有bug
        return name != self.name

    def _count_plugins(self) -> dict[str, int]:
        items = self._scan_plugins()
        return {"total": len(items), "loaded": sum(1 for i in items if i["status"] == "loaded")}

    def _load_stats(self) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        defaults = {"total": 0, "today": 0, "today_date": today, "history": []}
        if not self._stats_path or not self._stats_path.exists():
            self._stats = defaults
            return
        try:
            with open(self._stats_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for k, v in defaults.items():
                data.setdefault(k, v)
            self._stats = data
        except Exception:
            self._stats = defaults

    def _save_stats(self) -> None:
        if not self._stats_path:
            return
        try:
            with open(self._stats_path, "w", encoding="utf-8") as f:
                json.dump(self._stats, f, ensure_ascii=False)
        except Exception:
            pass


plugin = DashboardPlugin()
