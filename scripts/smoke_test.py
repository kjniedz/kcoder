"""Cross-platform smoke test (macOS, Linux, Windows; used by CI).

Runs an isolated kcoderd (temp data dir, its own port) with a fake `claude`
CLI first on PATH, so nothing touches your real daemon or Claude plan:

    python scripts/smoke_test.py

Checks: daemon start/status/stop, `kcoder plan`, a one-shot Claude Code turn,
the plan-limit cut-off, kcoder's own bash tool (streaming + kill), the
terminal view (pty / ConPTY), and the uninstall script dry run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOWS = os.name == "nt"
FAILS: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        FAILS.append(name)


FAKE_CLAUDE = textwrap.dedent('''
    import json, os, sys, time
    D = os.environ["KC_FAKE_DIR"]
    mode = json.load(open(os.path.join(D, "mode.json")))
    if sys.argv[1:3] == ["auth", "status"]:
        print(json.dumps({"loggedIn": True, "authMethod": mode.get("method", "claude.ai"), "apiProvider": "firstParty"}))
        sys.exit(0)
    if sys.argv[1:2] == ["--version"]:
        print("9.9.9 (fake)"); sys.exit(0)
    sys.stdin.read()
    def out(d):
        print(json.dumps(d)); sys.stdout.flush()
    out({"type": "system", "subtype": "init", "session_id": "s1", "apiKeySource": "none"})
    if mode.get("rle"):
        out({"type": "rate_limit_event", "rate_limit_info": mode["rle"]})
        time.sleep(1)
    text = "hello from the fake claude"
    out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"}}})
    out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}})
    out({"type": "stream_event", "event": {"type": "content_block_stop"}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
    out({"type": "result", "subtype": "success", "session_id": "s1", "usage": {"input_tokens": 5, "output_tokens": 3}})
''')


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="kcoder-smoke-")
    data = os.path.join(tmp, "data")
    fake = os.path.join(tmp, "bin")
    work = os.path.join(tmp, "work")
    for d in (data, fake, work):
        os.makedirs(d)
    with open(os.path.join(fake, "fake_claude.py"), "w", encoding="utf-8") as f:
        f.write(FAKE_CLAUDE)
    if WINDOWS:
        with open(os.path.join(fake, "claude.cmd"), "w", encoding="utf-8") as f:
            f.write(f'@"{sys.executable}" "%~dp0fake_claude.py" %*\r\n')
    else:
        p = os.path.join(fake, "claude")
        with open(p, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" "$(dirname "$0")/fake_claude.py" "$@"\n')
        os.chmod(p, 0o755)

    def mode(**m):
        with open(os.path.join(fake, "mode.json"), "w", encoding="utf-8") as f:
            json.dump(m, f)
    mode()

    env = dict(os.environ, KCODER_DATA_DIR=data, KCODER_PORT="47998", KCODER_UPDATE_DELAY="3600", KCODER_CONDITIONS="off",
               KCODER_AGENT_PLIST=os.path.join(data, "agent.plist"), KCODER_APP_BUNDLE=os.path.join(data, "kcoder.app"),
               KC_FAKE_DIR=fake, PATH=fake + os.pathsep + os.environ.get("PATH", ""),
               ANTHROPIC_API_KEY="sk-ant-api-must-not-reach-claude", PYTHONIOENCODING="utf-8")
    for k in [k for k in env if k.startswith("CLAUDE_CODE") or k == "CLAUDECODE"]:
        env.pop(k)

    def kc(*args, timeout=120):
        r = subprocess.run([sys.executable, "-m", "kcoder", *args], cwd=work, env=env, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")

    try:
        code, out = kc("--version")
        check("kcoder --version", code == 0 and "kcoder" in out, out[-300:])
        code, out = kc("daemon", "start")
        check("daemon start", code == 0, out[-500:])
        info = json.load(open(os.path.join(data, "daemon.json")))
        check("daemon.json written", info.get("port") == 47998, str(info))
        code, out = kc("daemon", "status")
        check("daemon status", code == 0, out[-300:])

        code, out = kc("plan")
        check("kcoder plan: on the plan", code == 0 and "on your Claude plan" in out, out[-300:])

        code, out = kc("-y", "--no-worktree", "--model", "opus", "say hi")
        check("one-shot turn through Claude Code", code == 0 and "hello from the fake claude" in out, out[-600:])

        mode(rle={"status": "allowed", "isUsingOverage": True, "rateLimitType": "seven_day_overage_included",
                  "resetsAt": int(time.time() + 7200)})
        code, out = kc("-y", "--no-worktree", "--model", "fable", "say hi")
        check("overage cut-off stops the turn", code != 0 and "kcoder stopped" in out, out[-600:])
        mode()
        code, out = kc("-y", "--no-worktree", "--model", "opus", "say hi")
        check("other models still run after a Fable limit", code == 0 and "hello" in out, out[-400:])

        # kcoder's own bash tool: streaming output and kill
        sys.path.insert(0, ROOT)
        os.environ["KCODER_DATA_DIR"] = data
        from kcoder import tools, compat
        streamed = []
        res = tools.run_bash("echo one && echo two", timeout=60, cwd=work, on_output=streamed.append, env=dict(os.environ))
        check("run_bash output", "one" in res and "two" in res, res[-300:])
        check("run_bash streams", "".join(streamed).count("one") == 1, repr(streamed)[:200])

        class Slot:
            proc = None
            kill_requested = False
        slot = Slot()
        import threading
        threading.Timer(2.0, lambda: setattr(slot, "kill_requested", True)).start()
        t0 = time.monotonic()
        sleeper = "sleep 30" if not WINDOWS or tools._windows_bash() else "ping -n 30 127.0.0.1 >NUL"
        tools.run_bash(sleeper, timeout=60, cwd=work, proc_slot=slot, env=dict(os.environ))
        check("run_bash kill", time.monotonic() - t0 < 15, f"took {time.monotonic() - t0:.1f}s")
        check("compat.pid_alive(self)", compat.pid_alive(os.getpid()))
        check("compat.pid_alive(dead)", not compat.pid_alive(slot.proc.pid if slot.proc else 999999))

        # the terminal view (pty on POSIX, ConPTY on Windows) through the daemon
        from websockets.sync.client import connect
        token = open(os.path.join(data, "token"), encoding="utf-8").read().strip()
        try:
            with connect("ws://127.0.0.1:47998/ws", open_timeout=10, max_size=64 * 1024 * 1024) as ws:
                def req(t, **kw):
                    rid = str(time.time())
                    ws.send(json.dumps({"type": t, "id": rid, **kw}))
                    deadline = time.time() + 30
                    while time.time() < deadline:
                        m = json.loads(ws.recv(timeout=30))
                        if m.get("type") == "reply" and m.get("id") == rid:
                            return m
                    return {}
                hello = req("auth", token=token)
                check("websocket auth", hello.get("ok") is True, json.dumps(hello)[:200])
                r = req("create", cwd=work, provider="claude", model="opus", name="smoke", worktree=False)
                sid = ((r.get("session") or {}).get("id")) if r.get("ok", True) else None
                check("create session over websocket", bool(sid), json.dumps(r)[:300])
                if sid:
                    r = req("shell_open", sid=sid, cols=80, rows=24)
                    ok = r.get("ok", True) and "error" not in r
                    check("terminal view opens", ok, json.dumps(r)[:300])
                    if ok:
                        import base64
                        req("shell_input", sid=sid, data=base64.b64encode(b"echo kc-shell-ok\r").decode())
                        got = ""
                        deadline = time.time() + 20
                        while time.time() < deadline and "kc-shell-ok" not in got:
                            try:
                                m = json.loads(ws.recv(timeout=5))
                            except TimeoutError:
                                continue
                            if m.get("type") == "shell" and m.get("data"):
                                import base64
                                got += base64.b64decode(m["data"]).decode("utf-8", "replace")
                        check("terminal view echoes", "kc-shell-ok" in got, got[-200:])
                        req("shell_close", sid=sid)
        except Exception as exc:  # noqa: BLE001
            check("websocket session + terminal", False, f"{type(exc).__name__}: {exc}")

        code, out = kc("uninstall", "--dry-run")
        check("uninstall dry run", code == 0 and ("Remove-Item" in out if WINDOWS else "rm -rf" in out), out[-300:])
    finally:
        code, out = kc("daemon", "stop")
        check("daemon stop", code == 0, out[-300:])
        time.sleep(1)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(FAILS)} failure(s)" + (": " + ", ".join(FAILS) if FAILS else ""))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
