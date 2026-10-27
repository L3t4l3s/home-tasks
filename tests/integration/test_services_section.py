"""home_tasks.add_task / update_task — the ``section`` field."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


@pytest.fixture
async def sections(hass: HomeAssistant, mock_config_entry, store) -> dict:
    admin = await store.async_add_section("Admin")
    house = await store.async_add_section("House & garden")
    return {"Admin": admin["id"], "House & garden": house["id"]}


def _task(store, title: str) -> dict:
    return next(t for t in store.tasks if t["title"] == title)


async def test_add_task_into_section_by_name(hass: HomeAssistant, store, sections) -> None:
    await hass.services.async_call(
        DOMAIN, "add_task",
        {"list_name": "Test List", "title": "Tax return", "section": "admin"},
        blocking=True,
    )
    assert _task(store, "Tax return")["section_id"] == sections["Admin"]


async def test_add_task_into_section_by_id(hass: HomeAssistant, store, sections) -> None:
    await hass.services.async_call(
        DOMAIN, "add_task",
        {"list_name": "Test List", "title": "Gutters", "section": sections["House & garden"]},
        blocking=True,
    )
    assert _task(store, "Gutters")["section_id"] == sections["House & garden"]


async def test_add_task_without_section_uses_list_default(
    hass: HomeAssistant, store, sections
) -> None:
    await store.async_set_defaults(section_id=sections["Admin"])
    await hass.services.async_call(
        DOMAIN, "add_task", {"list_name": "Test List", "title": "Passports"}, blocking=True,
    )
    assert _task(store, "Passports")["section_id"] == sections["Admin"]


async def test_update_task_moves_and_clears_section(hass: HomeAssistant, store, sections) -> None:
    task = await store.async_add_task("Defrost freezers")
    await hass.services.async_call(
        DOMAIN, "update_task",
        {"list_name": "Test List", "task_id": task["id"], "section": "House & garden"},
        blocking=True,
    )
    assert _task(store, "Defrost freezers")["section_id"] == sections["House & garden"]

    await hass.services.async_call(
        DOMAIN, "update_task",
        {"list_name": "Test List", "task_title": "Defrost freezers", "section": ""},
        blocking=True,
    )
    assert _task(store, "Defrost freezers")["section_id"] is None


async def test_unknown_section_is_rejected(hass: HomeAssistant, store, sections) -> None:
    task = await store.async_add_task("Plants")
    with pytest.raises(ServiceValidationError, match="No section"):
        await hass.services.async_call(
            DOMAIN, "update_task",
            {"list_name": "Test List", "task_id": task["id"], "section": "Garage"},
            blocking=True,
        )
    assert _task(store, "Plants")["section_id"] is None
