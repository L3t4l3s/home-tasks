"""Provider-side verifier for Todoist live tests.

TodoistAdapter talks directly to Todoist's REST API v1, bypassing HA's
own Todoist integration entity.  The "truth" for a given task therefore
lives on Todoist's servers, not in HA's cached state.  This module wraps
the same ``TodoistAPIClient`` the production adapter uses, so tests can
assert — for each operation — that the change really reached Todoist.

Usage::

    async def test_foo(ws_client, todoist_entity, todoist_verifier):
        ...
        task = await todoist_verifier.get_task(uid)
        assert task.content == "Expected title"

Returns the same ``TodoistTask`` dataclass the adapter uses.  Field
translation to home_tasks' own names (priority mapping, content↔title,
description↔notes, …) is done per-test, which makes adapter-side
mapping bugs (either direction) directly visible.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import aiohttp
import pytest

from custom_components.home_tasks.todoist_api import (
    TodoistAPIClient,
    TodoistAPIError,
    TodoistTask,
)

from .config import CONFIG


class TodoistVerifier:
    """Thin wrapper exposing the read-only half of TodoistAPIClient."""

    def __init__(self, token: str) -> None:
        self._client = TodoistAPIClient(token)

    # ------------------------------------------------------------------ #
    # Construction + context management
    # ------------------------------------------------------------------ #

    @classmethod
    def from_config(cls) -> "TodoistVerifier":
        """Build from the test config; skip the calling test if no token."""
        token = CONFIG.todoist_api_token
        if not token:
            pytest.skip(
                "HT_TODOIST_API_TOKEN not set — cannot verify Todoist "
                "provider-side state.  Extract it from the HA Todoist "
                "config entry and add to tests/live/.env."
            )
        return cls(token)

    async def __aenter__(self) -> "TodoistVerifier":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._client.close()

    # ------------------------------------------------------------------ #
    # Reads
    # ------------------------------------------------------------------ #

    async def get_task(self, task_id: str) -> TodoistTask:
        """Fetch a single task by id.  Raises on 404/410."""
        return await self._client.get_task(task_id)

    async def try_get_task(self, task_id: str) -> TodoistTask | None:
        """Return the task or None if it's effectively gone.

        "Gone" means: either a 404/410 from Todoist, OR the task still
        shows up on GET /tasks/{id} but with is_deleted=True (that's how
        Todoist's api/v1 signals soft deletion — the list endpoint filters
        them out but the single-item GET still returns the corpse).
        """
        try:
            task = await self._client.get_task(task_id)
        except TodoistAPIError as exc:
            if exc.status in (404, 410):
                return None
            raise
        if task.is_deleted:
            return None
        return task

    async def list_tasks_by_parent(
        self, project_id: str, parent_id: str
    ) -> list[TodoistTask]:
        """All open tasks in ``project_id`` whose parent_id matches."""
        tasks = await self._client.get_tasks(project_id=project_id)
        return [t for t in tasks if t.parent_id == parent_id]

    async def get_reminders(self, task_id: str) -> list[dict]:
        """Raw reminder dicts for a task (for reminder-specific tests)."""
        return await self._client.get_reminders(task_id)

    # ------------------------------------------------------------------ #
    # Helpers used across tests
    # ------------------------------------------------------------------ #

    async def project_id_for_task(self, task_id: str) -> str:
        """Resolve the project_id that owns the given task."""
        return (await self.get_task(task_id)).project_id


# The pytest fixture ``todoist_verifier`` lives in tests/live/conftest.py.
