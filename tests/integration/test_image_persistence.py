"""Integration tests for the task-image persistence pipeline.

Covers _cleanup_orphan_image (orphan GC), _save_image_to_public_media (disk
copy), the over-length image_url guard in ws_update_task, and the empty-title
fan-out guard in ws_generate_task_image.
"""
from __future__ import annotations

import pathlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant, SupportsResponse

from custom_components.home_tasks.const import MAX_IMAGE_URL_LENGTH
from custom_components.home_tasks.websocket_api import (
    _cleanup_orphan_image,
    _save_image_to_public_media,
)

pytestmark = pytest.mark.integration


async def _write_www(hass: HomeAssistant, name: str) -> pathlib.Path:
    """Create config/www/home_tasks/<name> and return its path."""
    d = pathlib.Path(hass.config.path("www", "home_tasks"))

    def _mk() -> None:
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(b"img")

    await hass.async_add_executor_job(_mk)
    return d / name


# --- _cleanup_orphan_image ---------------------------------------------------


async def test_cleanup_deletes_orphan(hass, store, mock_config_entry) -> None:
    """An old image no task references is deleted."""
    f = await _write_www(hass, "orphan.png")
    await _cleanup_orphan_image(hass, "/local/home_tasks/orphan.png", None)
    assert not f.exists()


async def test_cleanup_keeps_shared_file(hass, store, mock_config_entry) -> None:
    """An image still referenced by another task is kept."""
    f = await _write_www(hass, "shared.png")
    t = await store.async_add_task("ref")
    await store.async_update_task(t["id"], image_url="/local/home_tasks/shared.png")
    await _cleanup_orphan_image(hass, "/local/home_tasks/shared.png", None)
    assert f.exists()


async def test_cleanup_keeps_old_when_resave_failed(hass, store, mock_config_entry) -> None:
    """If the new value isn't a public /local file (failed re-save), keep the old one."""
    f = await _write_www(hass, "keep.png")
    await _cleanup_orphan_image(hass, "/local/home_tasks/keep.png", "media-source://x/y")
    assert f.exists()


async def test_cleanup_noop_for_same_file(hass, store, mock_config_entry) -> None:
    """Same file (only the ?v= cache-bust changed) is not deleted."""
    f = await _write_www(hass, "same.png")
    await _cleanup_orphan_image(
        hass, "/local/home_tasks/same.png?v=1", "/local/home_tasks/same.png?v=2"
    )
    assert f.exists()


# --- _save_image_to_public_media --------------------------------------------


async def test_save_copies_media_source_off_disk(
    hass, store, mock_config_entry, tmp_path
) -> None:
    """A media-source image is copied straight off disk into www, no HTTP."""
    src = tmp_path / "src.png"
    src.write_bytes(b"imgdata")
    resolved = SimpleNamespace(path=src, url="/media/local/x.png")
    conn = SimpleNamespace(refresh_token_id="x")
    with patch(
        "homeassistant.components.media_source.async_resolve_media",
        new=AsyncMock(return_value=resolved),
    ):
        result = await _save_image_to_public_media(
            hass, conn, "media-source://media_source/x.png", "out.png"
        )
    assert result == "/local/home_tasks/out.png"
    dest = pathlib.Path(hass.config.path("www", "home_tasks", "out.png"))
    assert dest.exists()
    assert await hass.async_add_executor_job(dest.read_bytes) == b"imgdata"


async def test_save_noop_for_already_local(hass, store, mock_config_entry) -> None:
    """An already-public /local URL is returned unchanged (no work)."""
    url = "/local/home_tasks/already.png?v=1"
    result = await _save_image_to_public_media(hass, SimpleNamespace(), url, "x.png")
    assert result == url


# --- ws_update_task over-length guard ----------------------------------------


async def test_ws_update_task_rejects_overlong_image_url(
    hass, hass_ws_client, mock_config_entry, store
) -> None:
    """An over-length image_url is rejected (before any download/copy I/O)."""
    task = await store.async_add_task("img")
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1,
        "type": "home_tasks/update_task",
        "list_id": mock_config_entry.entry_id,
        "task_id": task["id"],
        "image_url": "/local/" + "x" * (MAX_IMAGE_URL_LENGTH + 10),
    })
    msg = await client.receive_json()
    assert msg["success"] is False


# --- ws_generate_task_image empty-title fan-out guard ------------------------


async def test_generate_empty_title_does_not_fan_out(
    hass, hass_ws_client, mock_config_entry, store
) -> None:
    """Generating for a blank-title task must not overwrite other blank-title tasks."""
    t1 = await store.async_add_task("placeholder one")
    t2 = await store.async_add_task("placeholder two")
    # Force empty titles (unreachable via normal validation) to exercise the guard.
    store._data["tasks"][0]["title"] = ""
    store._data["tasks"][1]["title"] = ""

    async def _gen(call):  # noqa: ANN001
        return {"media_source_id": "media-source://media_source/g.png"}

    hass.services.async_register(
        "ai_task", "generate_image", _gen, supports_response=SupportsResponse.OPTIONAL
    )

    client = await hass_ws_client(hass)
    with patch(
        "custom_components.home_tasks.websocket_api._save_image_to_public_media",
        new=AsyncMock(return_value="/local/home_tasks/g.png"),
    ):
        await client.send_json({
            "id": 1,
            "type": "home_tasks/generate_task_image",
            "entry_id": mock_config_entry.entry_id,
            "task_id": t1["id"],
            "entity_id": "ai_task.test",
            "force": True,
        })
        msg = await client.receive_json()

    assert msg["success"] is True, msg
    assert store.get_task(t1["id"])["image_url"].startswith("/local/home_tasks/g.png")
    assert not store.get_task(t2["id"]).get("image_url")
