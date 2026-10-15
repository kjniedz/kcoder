"""Deploy status per repo, read-only.

Targets are found in the repo's own config:

- Cloudflare: wrangler.toml / wrangler.json / wrangler.jsonc. A
  `pages_build_output_dir` makes it a Pages project, anything else a Worker
  (static-assets Workers included).
- Railway: railway.json / railway.toml (the project is whatever the folder
  is linked to: `railway status`).
- Supabase: supabase/config.toml, project ref from supabase/.temp/project-ref.

Status comes from the provider CLI the user is already logged into
(`wrangler`, `railway`, `supabase`), through listing commands only: this
module never deploys, never writes. Every target gets one of

    live       the last deploy succeeded (or a Worker has an active deployment)
    building   a deploy is in progress
    failed     the last deploy failed
    none       nothing deployed yet (or the CLI cannot see it)
    error      the CLI could not answer (not installed, not logged in, wrong account)

with the time of the last deploy, a short detail, and a URL when known.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import threading
import time

from . import paths

CACHE_PATH = os.path.join(paths.DATA_DIR, "deploys.json")
CONFIG_FILES = ("wrangler.toml", "wrangler.json", "wrangler.jsonc", "railway.json", "railway.toml", "supabase/config.toml")
CLI_TIMEOUT = 60
_lock = threading.Lock()


# ----------------------------------------------------------------------
# detection
# ----------------------------------------------------------------------

def _strip_jsonc(text: str) -> str:
    out = re.sub(r"(?m)^\s*//.*$", "", text)
    out = re.sub(r"/\*.*?\*/", "", out, flags=re.S)
    out = re.sub(r"(?<![:\"'\w])//[^\n\"]*$", "", out, flags=re.M)
    return re.sub(r",(\s*[}\]])", r"\1", out)


def _load_json_or_toml(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if path.endswith(".toml"):
        try:
            import tomllib
            return tomllib.loads(text)
        except Exception:  # noqa: BLE001 - a broken config is simply "no target"
            return {}
    for cand in (text, _strip_jsonc(text)):
        try:
            data = json.loads(cand)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            continue
    return {}


def has_targets(root: str) -> bool:
    return any(os.path.isfile(os.path.join(root, f)) for f in CONFIG_FILES)


def detect(root: str) -> list:
    """[{provider, kind, name, config, account_id?, project_ref?}] for a repo root."""
    out = []
    if not root or not os.path.isdir(root):
        return out
    for name in ("wrangler.toml", "wrangler.json", "wrangler.jsonc"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            cfg = _load_json_or_toml(p)
            kind = "pages" if cfg.get("pages_build_output_dir") else "worker"
            out.append({"provider": "cloudflare", "kind": kind, "name": str(cfg.get("name") or os.path.basename(root)),
                        "config": name, "account_id": cfg.get("account_id")})
            break
    for name in ("railway.json", "railway.toml"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            out.append({"provider": "railway", "kind": "service", "name": os.path.basename(root), "config": name})
            break
    sb = os.path.join(root, "supabase", "config.toml")
    if os.path.isfile(sb):
        cfg = _load_json_or_toml(sb)
        ref = None
        try:
            with open(os.path.join(root, "supabase", ".temp", "project-ref"), "r", encoding="utf-8") as f:
                ref = f.read().strip() or None
        except OSError:
            pass
        out.append({"provider": "supabase", "kind": "project", "name": str(cfg.get("project_id") or ref or os.path.basename(root)),
                    "config": "supabase/config.toml", "project_ref": ref})
    return out


# ----------------------------------------------------------------------
# status through the CLIs
# ----------------------------------------------------------------------

def _run(args: list, cwd: str) -> tuple[int, str, str]:
    env = dict(os.environ)
    env.setdefault("NO_COLOR", "1")
    env.setdefault("CI", "1")            # non-interactive: no prompts, no update nags
    try:
        r = subprocess.run(args, cwd=cwd if os.path.isdir(cwd) else None, capture_output=True, text=True, timeout=CLI_TIMEOUT, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return 124, "", f"{args[0]} timed out after {CLI_TIMEOUT}s"
    except OSError as exc:
        return 127, "", str(exc)
    return r.returncode, r.stdout or "", r.stderr or ""


def _json_out(text: str):
    """The JSON in a CLI's stdout, skipping banners around it."""
    text = text.strip()
    for start in ("[", "{"):
        i = text.find(start)
        if i >= 0:
            try:
                return json.loads(text[i:])
            except json.JSONDecodeError:
                continue
    return None


def _ts(value) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value) / (1000.0 if value > 1e11 else 1.0)
    try:
        s = str(value).replace("Z", "+00:00")
        d = dt.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.timestamp()
    except ValueError:
        return None


def _cli_error(provider: str, bin_name: str, err: str) -> dict:
    low = (err or "").lower()
    if "not logged in" in low or "login" in low and "run" in low or "authentication error" in low or "code: 10000" in low or "unauthorized" in low:
        detail = f"{bin_name} is not logged in to the account that owns this project"
    elif "does not exist" in low or "not found" in low or "code: 10007" in low:
        return {"state": "none", "detail": "not deployed on this account yet"}
    else:
        detail = re.sub(r"\x1b\[[0-9;]*m", "", err).strip().splitlines()[0][:200] if err.strip() else f"{bin_name} failed"
    return {"state": "error", "detail": detail}


def _cloudflare(target: dict, cwd: str) -> dict:
    binp = shutil.which("wrangler") or shutil.which("npx")
    if not binp:
        return {"state": "error", "detail": "wrangler is not installed"}
    base = [binp] if binp.endswith("wrangler") else [binp, "--yes", "wrangler"]
    if target.get("kind") == "pages":
        code, out, err = _run(base + ["pages", "deployment", "list", "--project-name", target["name"], "--environment", "production", "--json"], cwd)
        if code != 0:
            return _cli_error("cloudflare", "wrangler", err or out)
        rows = _json_out(out) or []
        if not isinstance(rows, list) or not rows:
            return {"state": "none", "detail": "no production deployment yet"}
        d = rows[0]
        stage = d.get("latest_stage") or {}
        st = str(stage.get("status") or "").lower()
        state = "live" if st == "success" else "failed" if st in ("failure", "failed", "canceled", "cancelled") else "building" if st in ("active", "idle", "queued", "running") else "none"
        meta = ((d.get("deployment_trigger") or {}).get("metadata") or {})
        return {"state": state, "at": _ts(stage.get("ended_on") or d.get("modified_on") or d.get("created_on")), "url": d.get("url"),
                "detail": f"{stage.get('name') or 'deploy'} {st}".strip() + (f" · {meta.get('branch')}@{str(meta.get('commit_hash') or '')[:7]}" if meta.get("branch") else ""),
                "id": d.get("id"), "branch": meta.get("branch"), "commit": meta.get("commit_hash"),
                "dashboard": f"https://dash.cloudflare.com/?to=/:account/pages/view/{target['name']}"}
    code, out, err = _run(base + ["deployments", "list", "--name", target["name"], "--json"], cwd)
    if code != 0:
        return _cli_error("cloudflare", "wrangler", err or out)
    rows = _json_out(out)
    if isinstance(rows, dict):
        rows = rows.get("deployments") or rows.get("result") or []
    if not isinstance(rows, list) or not rows:
        return {"state": "none", "detail": "no deployment yet"}
    d = rows[0]
    ann = d.get("annotations") or {}
    msg = ann.get("workers/message") or ann.get("workers/triggered_by") or ""
    versions = d.get("versions") or []
    return {"state": "live", "at": _ts(d.get("created_on")), "id": d.get("id"),
            "detail": (f"{d.get('source') or 'deploy'}" + (f" · {msg}" if msg else "") + (f" · {len(versions)} version(s)" if len(versions) > 1 else "")).strip(),
            "author": d.get("author_email"), "dashboard": f"https://dash.cloudflare.com/?to=/:account/workers/services/view/{target['name']}"}


def _railway(target: dict, cwd: str) -> dict:
    binp = shutil.which("railway")
    if not binp:
        return {"state": "error", "detail": "the railway CLI is not installed"}
    code, out, err = _run([binp, "status", "--json"], cwd)
    if code != 0:
        return _cli_error("railway", "railway", err or out)
    st = _json_out(out) or {}
    # the linked service's latest deployment, if the CLI gives it; shapes differ by version, so look in a few places
    deploy = None
    for svc in (st.get("services") or {}).get("edges", []) if isinstance(st.get("services"), dict) else (st.get("services") or []):
        node = svc.get("node") if isinstance(svc, dict) and "node" in svc else svc
        for inst in ((node or {}).get("serviceInstances") or {}).get("edges", []) if isinstance((node or {}).get("serviceInstances"), dict) else []:
            n = inst.get("node") or {}
            if n.get("latestDeployment"):
                deploy = n["latestDeployment"]
                deploy.setdefault("serviceName", (node or {}).get("name"))
    if deploy is None:
        code, out, err = _run([binp, "deployment", "list", "--json"], cwd)
        rows = _json_out(out) if code == 0 else None
        if isinstance(rows, list) and rows:
            deploy = rows[0]
    if not deploy:
        return {"state": "none", "detail": f"project {st.get('name') or ''}: no deployment yet".strip(), "project": st.get("name")}
    status = str(deploy.get("status") or "").upper()
    state = ("live" if status in ("SUCCESS", "COMPLETED", "DEPLOYED") else "building" if status in ("BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING")
             else "failed" if status in ("FAILED", "CRASHED", "ERROR") else "none" if status in ("REMOVED", "SKIPPED", "SLEEPING") else "live")
    meta = deploy.get("meta") or {}
    return {"state": state, "at": _ts(deploy.get("createdAt") or deploy.get("updatedAt")), "id": deploy.get("id"),
            "detail": f"{deploy.get('serviceName') or st.get('name') or 'service'} · {status.lower() or 'deployed'}" + (f" · {meta.get('branch')}@{str(meta.get('commitHash') or '')[:7]}" if meta.get("branch") else ""),
            "url": deploy.get("staticUrl") or deploy.get("url"), "project": st.get("name"), "dashboard": "https://railway.com/dashboard"}


def _supabase(target: dict, cwd: str) -> dict:
    binp = shutil.which("supabase")
    if not binp:
        return {"state": "error", "detail": "the supabase CLI is not installed"}
    ref = target.get("project_ref")
    code, out, err = _run([binp, "projects", "list", "-o", "json"], cwd)
    if code != 0:
        return _cli_error("supabase", "supabase", err or out)
    rows = _json_out(out) or []
    proj = None
    for r in rows if isinstance(rows, list) else []:
        if (ref and (r.get("id") == ref or r.get("ref") == ref)) or (not ref and r.get("name") == target.get("name")):
            proj = r
            break
    if proj is None:
        return {"state": "none", "detail": "project not linked (supabase link) or not on this account"}
    status = str(proj.get("status") or "").upper()
    state = "live" if "HEALTHY" in status or status in ("ACTIVE", "RUNNING") else "building" if status in ("COMING_UP", "RESTARTING", "UPGRADING", "PAUSING") else "failed" if "UNHEALTHY" in status or status in ("INIT_FAILED",) else "none"
    detail = f"{proj.get('name') or ref} · {status.lower() or 'unknown'}"
    at = None
    if ref:
        code, out, err = _run([binp, "functions", "list", "--project-ref", ref, "-o", "json"], cwd)
        fns = _json_out(out) if code == 0 else None
        if isinstance(fns, list) and fns:
            at = max((_ts(f.get("updated_at")) or 0 for f in fns), default=None) or None
            detail += f" · {len(fns)} function(s)"
    return {"state": state, "at": at, "detail": detail, "project": proj.get("name"), "dashboard": f"https://supabase.com/dashboard/project/{ref}" if ref else "https://supabase.com/dashboard"}


def status(target: dict, cwd: str) -> dict:
    fn = {"cloudflare": _cloudflare, "railway": _railway, "supabase": _supabase}.get(target.get("provider"))
    if fn is None:
        return {"state": "error", "detail": "unknown provider"}
    try:
        out = fn(target, cwd)
    except Exception as exc:  # noqa: BLE001 - a CLI surprise is a status, not a crash
        out = {"state": "error", "detail": f"{type(exc).__name__}: {exc}"[:200]}
    out.setdefault("at", None)
    out["checked"] = time.time()
    return out


def failure_log(target: dict, st: dict, cwd: str, max_lines: int = 250) -> str:
    """What we can get for a failed deploy: Railway build / deploy logs; for
    Cloudflare and Supabase the deployment record (the CLIs expose no build log)."""
    head = f"### {target['provider']} {target.get('kind') or ''} `{target['name']}` deploy {st.get('state')}\n{st.get('detail') or ''}"
    if st.get("dashboard"):
        head += f"\n{st['dashboard']}"
    if st.get("url"):
        head += f"\n{st['url']}"
    log = ""
    if target.get("provider") == "railway" and shutil.which("railway"):
        for args in (["railway", "logs", "--build", "--json"], ["railway", "logs", "--deployment", "--json"], ["railway", "logs"]):
            if st.get("id") and args[-1] != "logs":
                args = args[:2] + ["-d", str(st["id"])] + args[2:]
            code, out, err = _run(args, cwd)
            lines = [l for l in (out or "").splitlines() if l.strip()]
            if code == 0 and lines:
                log = "\n".join(lines[-max_lines:])
                break
    elif target.get("provider") == "cloudflare" and shutil.which("wrangler") and target.get("kind") == "pages":
        code, out, err = _run(["wrangler", "pages", "deployment", "list", "--project-name", target["name"], "--environment", "production", "--json"], cwd)
        rows = _json_out(out) if code == 0 else None
        if isinstance(rows, list) and rows:
            log = json.dumps({k: rows[0].get(k) for k in ("id", "url", "created_on", "latest_stage", "stages", "deployment_trigger") if k in rows[0]}, indent=1)[-12000:]
    return head + ("\n```\n" + log[-12000:] + "\n```" if log else "\n(no build log is available through the CLI; the dashboard link above has it)")


# ----------------------------------------------------------------------
# cache: one entry per repo root
# ----------------------------------------------------------------------

def _load() -> dict:
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    paths.ensure_data_dir()
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE_PATH)


def get(root: str) -> dict | None:
    with _lock:
        return _load().get(root)


def all_entries() -> dict:
    with _lock:
        return _load()


def refresh(root: str) -> dict:
    """Detect targets and ask each provider; the entry is cached per root."""
    targets = detect(root)
    entry = {"root": root, "checked": time.time(), "targets": []}
    for t in targets:
        entry["targets"].append({**t, "status": status(t, root)})
    states = [t["status"]["state"] for t in entry["targets"]]
    entry["state"] = ("failed" if "failed" in states else "building" if "building" in states else "live" if "live" in states
                      else "error" if "error" in states else "none" if states else "untracked")
    entry["at"] = max((t["status"].get("at") or 0 for t in entry["targets"]), default=0) or None
    with _lock:
        data = _load()
        data[root] = entry
        _save(data)
    return entry


def forget(root: str) -> None:
    with _lock:
        data = _load()
        if data.pop(root, None) is not None:
            _save(data)
