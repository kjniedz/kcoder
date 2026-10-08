"""Scheduled tasks: recurring jobs per repo that feed the task queue.

<data dir>/schedules.json: {"schedules": [...]}
schedule: {"id", "name", "repo", "text", "provider", "model", "trust", "every": "hour|day|week",
           "at": "HH:MM", "weekday": 0-6 (Monday=0, for week), "enabled", "pr": bool,
           "created", "last_run", "last_result", "next_run"}

A due job runs once even if several intervals were missed (the Mac was
asleep): next_run is always computed from now, never from the missed slot.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time
import uuid

from . import paths

SCHEDULES_PATH = os.path.join(paths.DATA_DIR, "schedules.json")
EVERY = ("hour", "day", "week")


def _parse_at(at: str) -> tuple:
    try:
        h, m = str(at or "09:00").split(":")
        return max(0, min(23, int(h))), max(0, min(59, int(m)))
    except ValueError:
        return 9, 0


def compute_next(s: dict, after: float | None = None) -> float:
    """The first run time strictly after `after` (default now)."""
    now = dt.datetime.fromtimestamp(after or time.time())
    h, m = _parse_at(s.get("at"))
    every = s.get("every") if s.get("every") in EVERY else "day"
    if every == "hour":
        cand = now.replace(minute=m, second=0, microsecond=0)
        while cand <= now:
            cand += dt.timedelta(hours=1)
        return cand.timestamp()
    cand = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if every == "day":
        while cand <= now:
            cand += dt.timedelta(days=1)
        return cand.timestamp()
    wd = int(s.get("weekday") or 0) % 7
    while cand.weekday() != wd or cand <= now:
        cand += dt.timedelta(days=1)
    return cand.timestamp()


class Schedules:
    def __init__(self, path: str = SCHEDULES_PATH):
        self.path = path
        self.items: list = []
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self.items = [s for s in (json.load(f).get("schedules") or []) if isinstance(s, dict)]
        except (FileNotFoundError, json.JSONDecodeError):
            self.items = []

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"schedules": self.items}, f, indent=1)
        os.replace(tmp, self.path)

    def add(self, **fields) -> dict:
        s = {"id": uuid.uuid4().hex[:8], "name": fields.get("name") or "scheduled task", "repo": fields["repo"],
             "text": fields["text"], "provider": fields.get("provider"), "model": fields.get("model"),
             "trust": fields.get("trust"), "every": fields.get("every") if fields.get("every") in EVERY else "day",
             "at": fields.get("at") or "09:00", "weekday": int(fields.get("weekday") or 0), "enabled": True,
             "pr": bool(fields.get("pr", True)), "created": time.time(), "last_run": None, "last_result": None}
        s["next_run"] = compute_next(s)
        self.items.append(s)
        self.save()
        return s

    def get(self, sid: str) -> dict | None:
        return next((s for s in self.items if s["id"] == sid), None)

    def update(self, sid: str, **fields) -> dict | None:
        s = self.get(sid)
        if s:
            s.update(fields)
            if any(k in fields for k in ("every", "at", "weekday")):
                s["next_run"] = compute_next(s)
            self.save()
        return s

    def remove(self, sid: str) -> bool:
        n = len(self.items)
        self.items = [s for s in self.items if s["id"] != sid]
        self.save()
        return len(self.items) != n

    def due(self, now: float | None = None) -> list:
        now = now or time.time()
        return [s for s in self.items if s.get("enabled") and (s.get("next_run") or 0) <= now]

    def mark_started(self, sid: str, task_id: str) -> None:
        s = self.get(sid)
        if s:
            s["last_run"] = time.time()
            s["last_task"] = task_id
            s["next_run"] = compute_next(s)     # from now: a missed job runs once, never a backlog
            self.save()
