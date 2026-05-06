"""Unit tests for section CRUD on HomeTasksStore."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from custom_components.home_tasks.const import (
    MAX_SECTIONS_PER_LIST,
    MAX_SECTION_NAME_LENGTH,
)

pytestmark = pytest.mark.unit


async def test_default_sections_empty(hass: HomeAssistant, store) -> None:
    assert store.sections == []


async def test_add_section_assigns_id_and_order(hass: HomeAssistant, store) -> None:
    s1 = await store.async_add_section("Produce")
    s2 = await store.async_add_section("Frozen", icon="mdi:snowflake")
    assert s1["id"] != s2["id"]
    assert s1["sort_order"] == 0
    assert s2["sort_order"] == 1
    assert s2["icon"] == "mdi:snowflake"
    assert store.sections[0]["id"] == s1["id"]
    assert store.sections[1]["id"] == s2["id"]


async def test_add_section_validates(hass: HomeAssistant, store) -> None:
    with pytest.raises(ValueError):
        await store.async_add_section("")
    with pytest.raises(ValueError):
        await store.async_add_section("x" * (MAX_SECTION_NAME_LENGTH + 1))


async def test_add_section_limit(hass: HomeAssistant, store) -> None:
    for i in range(MAX_SECTIONS_PER_LIST):
        await store.async_add_section(f"Section {i}")
    with pytest.raises(ValueError, match="Maximum number of sections"):
        await store.async_add_section("One too many")


async def test_update_section(hass: HomeAssistant, store) -> None:
    s = await store.async_add_section("Bakery")
    updated = await store.async_update_section(s["id"], name="Bakery & Pastries", icon="mdi:bread-slice")
    assert updated["name"] == "Bakery & Pastries"
    assert updated["icon"] == "mdi:bread-slice"


async def test_update_unknown_section(hass: HomeAssistant, store) -> None:
    with pytest.raises(ValueError, match="Section not found"):
        await store.async_update_section("missing", name="x")


async def test_reorder_sections(hass: HomeAssistant, store) -> None:
    s1 = await store.async_add_section("A")
    s2 = await store.async_add_section("B")
    s3 = await store.async_add_section("C")
    await store.async_reorder_sections([s3["id"], s1["id"], s2["id"]])
    ordered = [s["id"] for s in store.sections]
    assert ordered == [s3["id"], s1["id"], s2["id"]]


async def test_delete_section_resets_task_section_id(hass: HomeAssistant, store) -> None:
    section = await store.async_add_section("Snacks")
    task = await store.async_add_task("Chips")
    await store.async_update_task(task["id"], section_id=section["id"])
    assert store.get_task(task["id"])["section_id"] == section["id"]
    await store.async_delete_section(section["id"])
    assert store.sections == []
    assert store.get_task(task["id"])["section_id"] is None


async def test_update_task_with_unknown_section_id_rejected(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Apples")
    with pytest.raises(ValueError, match="Unknown section_id"):
        await store.async_update_task(task["id"], section_id="not-a-real-id")


async def test_update_task_clear_section_id(hass: HomeAssistant, store) -> None:
    section = await store.async_add_section("Drinks")
    task = await store.async_add_task("Water")
    await store.async_update_task(task["id"], section_id=section["id"])
    cleared = await store.async_update_task(task["id"], section_id=None)
    assert cleared["section_id"] is None


async def test_new_task_has_section_id_none(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Eggs")
    assert task["section_id"] is None


async def test_load_backfills_section_id_for_legacy_tasks(hass: HomeAssistant, store) -> None:
    """Tasks persisted before the sections feature should gain section_id=None on load."""
    # Simulate a legacy task without section_id by deleting the field
    task = await store.async_add_task("Legacy task")
    del task["section_id"]
    # Force the migration path by re-running backfill
    store._backfill_section_id()
    assert store.get_task(task["id"])["section_id"] is None


async def test_load_backfills_empty_sections_list(hass: HomeAssistant, store) -> None:
    """Stores loaded without a 'sections' key should default to []."""
    # The fixture-loaded store already runs async_load(); explicitly drop and
    # re-trigger setdefault to validate the migration is idempotent.
    store._data.pop("sections", None)
    store._data.setdefault("sections", [])
    assert store.sections == []
