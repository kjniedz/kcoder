"""The fleet task queue: tasks with a repo, model, provider and trust level
that start on their own as session slots free up, each in its own worktree.
Finished tasks land in review (their session is marked for review), never
straight to a push.

<data dir>/tasks.json: {"paused": bool, "tasks": [...]}
task: {"id", "text", "repo", "provider", "model", "trust", "name", "status",
       "sid", "created", "started", "finished", "error"}
status: queued | running | review | failed | cancelled
"""

from __future__ import annotations

import json
import os
import time
import uuid

from . import paths

TASKS_PATH = os.path.join(paths.DATA_DIR, "tasks.json")
OPEN = ("queued", "running")


class TaskQueue:
    def __init__(self, path: str = TASKS_PATH):
        self.path = path
        self.paused = False
        self.tasks: list = []
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.paused = bool(data.get("paused"))
            self.tasks = [t for t in data.get("tasks") or [] if isinstance(t, dict)]
        except (FileNotFoundError, json.JSONDecodeError):
            self.paused, self.tasks = False, []

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"paused": self.paused, "tasks": self.tasks}, f, indent=1)
        os.replace(tmp, self.path)

    def add(self, text: str, repo: str, *, provider: str | None, model: str | None, trust: str | None,
            name: str | None = None, schedule_id: str | None = None) -> dict:
        t = {"id": uuid.uuid4().hex[:8], "text": text.strip(), "repo": repo, "provider": provider, "model": model,
             "trust": trust, "name": name or None, "status": "queued", "sid": None, "created": time.time(),
             "started": None, "finished": None, "error": None, "schedule_id": schedule_id}
        self.tasks.append(t)
        self.save()
        return t

    def get(self, tid: str) -> dict | None:
        return next((t for t in self.tasks if t["id"] == tid), None)

    def by_sid(self, sid: str) -> dict | None:
        return next((t for t in self.tasks if t.get("sid") == sid and t["status"] == "running"), None)

    def update(self, tid: str, **fields) -> dict | None:
        t = self.get(tid)
        if t:
            t.update(fields)
            self.save()
        return t

    def remove(self, tid: str) -> bool:
        before = len(self.tasks)
        self.tasks = [t for t in self.tasks if t["id"] != tid]
        self.save()
        return len(self.tasks) != before

    def reorder(self, ids: list) -> None:
        """Queued tasks take the order of `ids`; everything else keeps its place."""
        order = {tid: i for i, tid in enumerate(ids)}
        queued = sorted([t for t in self.tasks if t["status"] == "queued"], key=lambda t: order.get(t["id"], 10**6))
        it = iter(queued)
        self.tasks = [next(it) if t["status"] == "queued" else t for t in self.tasks]
        self.save()

    def next_queued(self) -> dict | None:
        return next((t for t in self.tasks if t["status"] == "queued"), None)

    def running(self) -> list:
        return [t for t in self.tasks if t["status"] == "running"]

    def clear_finished(self) -> int:
        n = len(self.tasks)
        self.tasks = [t for t in self.tasks if t["status"] in OPEN]
        self.save()
        return n - len(self.tasks)

    def summary(self) -> dict:
        c = {}
        for t in self.tasks:
            c[t["status"]] = c.get(t["status"], 0) + 1
        return {"paused": self.paused, "counts": c, "tasks": list(self.tasks)}
