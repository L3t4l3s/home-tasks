"""add_task / update_task set what the card's task editor sets: recurrence,
section and picture — on native lists and on linked ones."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError

from tests.integration.linked_list_helpers import LIST_NAME, call, overlay

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


async def _native(hass, entry, service, **data):
    await call(hass, service, entry_id=entry.entry_id, **data)


# ---------------------------------------------------------------------------
# Native lists
# ---------------------------------------------------------------------------

async def test_add_task_creates_a_recurring_task_in_one_go(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_set_defaults(recurrence_reopen_lead=2 * 1440)
    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_created", events.append)
    await _native(
        hass, mock_config_entry, "add_task", title="Bins",
        recurrence_unit="weeks", recurrence_weekdays="mon,thu", recurrence_time="07:00:00",
    )
    task = next(t for t in store.tasks if t["title"] == "Bins")
    assert task["recurrence_enabled"] is True
    assert task["recurrence_weekdays"] == [0, 3]
    assert task["recurrence_time"] == "07:00"
    # it starts recurring: the list's lead, which fits Mon/Thu
    assert task["recurrence_reopen_lead"] == 2 * 1440
    assert len(events) == 1
    assert [h["action"] for h in task["history"]] == ["created"]


async def test_add_task_with_an_end_after_some_times(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await _native(hass, mock_config_entry, "add_task", title="Pills", recurrence_unit="days", recurrence_max_count=5)
    task = next(t for t in store.tasks if t["title"] == "Pills")
    assert (task["recurrence_end_type"], task["recurrence_remaining_count"]) == ("count", 5)


async def test_update_task_changes_the_recurrence(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    task = await store.async_add_task("Rent")
    await _native(
        hass, mock_config_entry, "update_task", task_id=task["id"],
        recurrence_unit="months", recurrence_day_of_month="last", recurrence_reopen_lead=3 * 1440,
    )
    t = store.get_task(task["id"])
    assert (t["recurrence_month_pattern"], t["recurrence_day_of_month"]) == ("day_of_month", "last")
    assert t["recurrence_reopen_lead"] == 3 * 1440
    await _native(hass, mock_config_entry, "update_task", task_id=task["id"], recurrence_enabled=False)
    assert store.get_task(task["id"])["recurrence_enabled"] is False


async def test_a_bad_combination_changes_nothing(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    task = await store.async_add_task("Rent")
    with pytest.raises(ServiceValidationError, match="months"):
        await _native(
            hass, mock_config_entry, "update_task", task_id=task["id"],
            title="Renamed", recurrence_unit="weeks", recurrence_day_of_month=3,
        )
    assert store.get_task(task["id"])["title"] == "Rent"


async def test_sections_by_name(hass: HomeAssistant, mock_config_entry, store) -> None:
    kitchen = await store.async_add_section("Kitchen")
    await _native(hass, mock_config_entry, "add_task", title="Wipe", section="kitchen")
    task = next(t for t in store.tasks if t["title"] == "Wipe")
    assert task["section_id"] == kitchen["id"]
    await _native(hass, mock_config_entry, "update_task", task_id=task["id"], section="")
    assert store.get_task(task["id"])["section_id"] is None
    with pytest.raises(ServiceValidationError, match="Kitchen"):
        await _native(hass, mock_config_entry, "update_task", task_id=task["id"], section="Attic")


async def test_a_picture_is_set_and_removed(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Plants")
    url = "https://example.com/plants.png"
    await _native(hass, mock_config_entry, "update_task", task_id=task["id"], image_url=url)
    assert store.get_task(task["id"])["image_url"] == url
    await _native(hass, mock_config_entry, "update_task", task_id=task["id"], image_url="")
    assert store.get_task(task["id"])["image_url"] is None


async def test_a_picture_is_drawn_with_the_list_s_settings(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    gen = AsyncMock(return_value={"task": {}, "reused": False})
    with patch("custom_components.home_tasks.websocket_api.async_generate_task_image", gen):
        await _native(hass, mock_config_entry, "add_task", title="Plants", generate_image=True)
        task = next(t for t in store.tasks if t["title"] == "Plants")
        await _native(hass, mock_config_entry, "update_task", task_id=task["id"], generate_image=True)
    first, again = gen.await_args_list
    assert first.kwargs["task_id"] == task["id"]
    assert first.kwargs["entry_id"] == mock_config_entry.entry_id
    assert (first.kwargs["force"], again.kwargs["force"]) == (False, True)


async def test_a_failed_drawing_says_the_task_was_saved(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    gen = AsyncMock(side_effect=ValueError("No ai_task entity found"))
    with patch("custom_components.home_tasks.websocket_api.async_generate_task_image", gen):
        with pytest.raises(HomeAssistantError, match="task was saved"):
            await _native(hass, mock_config_entry, "add_task", title="Plants", generate_image=True)
    assert any(t["title"] == "Plants" for t in store.tasks)


async def test_url_and_drawing_together_are_refused(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    with pytest.raises(ServiceValidationError):
        await _native(
            hass, mock_config_entry, "add_task", title="Plants",
            image_url="https://example.com/p.png", generate_image=True,
        )
    assert not any(t["title"] == "Plants" for t in store.tasks)


async def test_position_top_or_bottom(hass: HomeAssistant, mock_config_entry, store) -> None:
    for title in ("A", "B", "C"):
        await store.async_add_task(title)
    order = lambda: [t["title"] for t in sorted(store.tasks, key=lambda t: t["sort_order"])]
    await _native(hass, mock_config_entry, "add_task", title="Urgent", position="top")
    assert order() == ["Urgent", "A", "B", "C"]
    b = next(t for t in store.tasks if t["title"] == "B")
    await _native(hass, mock_config_entry, "update_task", task_id=b["id"], position="bottom")
    assert order() == ["Urgent", "A", "C", "B"]
    await _native(hass, mock_config_entry, "update_task", task_id=b["id"], position="top")
    assert order() == ["B", "Urgent", "A", "C"]


# ---------------------------------------------------------------------------
# Linked lists
# ---------------------------------------------------------------------------

async def test_recurrence_on_a_linked_list_takes_the_card_s_route(
    hass: HomeAssistant, linked_list
) -> None:
    entry, adapter = linked_list
    await call(
        hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench",
        recurrence_unit="weeks", recurrence_weekdays=["fri"],
    )
    uid, fields = adapter.updated[-1]
    assert uid == "uid-1"
    assert fields["recurrence_weekdays"] == [4]
    assert overlay(hass, entry).get_overlay("uid-1")["recurrence_enabled"] is True


async def test_a_linked_list_has_no_reopen_lead(hass: HomeAssistant, linked_list) -> None:
    with pytest.raises(ServiceValidationError, match="Home Tasks lists"):
        await call(
            hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench",
            recurrence_unit="weeks", recurrence_reopen_lead=60,
        )


async def test_a_section_on_a_linked_list_goes_to_the_overlay(
    hass: HomeAssistant, linked_list
) -> None:
    entry, adapter = linked_list
    section = await overlay(hass, entry).async_add_section("Today")
    await call(hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench", section="Today")
    assert overlay(hass, entry).get_overlay("uid-1")["section_id"] == section["id"]
    assert not adapter.updated, "a section is ours alone — the provider isn't asked"


async def test_add_task_on_a_linked_list_with_recurrence_and_section(
    hass: HomeAssistant, linked_list
) -> None:
    entry, adapter = linked_list
    section = await overlay(hass, entry).async_add_section("Today")
    await call(
        hass, "add_task", list_name=LIST_NAME, title="Water plants",
        recurrence_unit="days", recurrence_value=3, section="Today",
    )
    uid, fields = adapter.updated[-1]
    assert uid == "uid-new"
    assert (fields["recurrence_unit"], fields["recurrence_value"]) == ("days", 3)
    stored = overlay(hass, entry).get_overlay("uid-new")
    assert stored["section_id"] == section["id"]
    assert stored["recurrence_enabled"] is True


async def test_position_on_a_linked_list_takes_the_card_s_route(
    hass: HomeAssistant, linked_list
) -> None:
    entry, _adapter = linked_list
    await call(hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench", position="bottom")
    store = overlay(hass, entry)
    assert store.get_overlay("uid-1")["sort_order"] > store.get_overlay("uid-2")["sort_order"]
