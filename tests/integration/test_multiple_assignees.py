"""Several assignees per task (issue #75).

assigned_persons holds everyone (primary first); assigned_person stays the
primary so every existing consumer keeps working."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
ANNA, KEVIN, MIA = "person.anna", "person.kevin", "person.mia"


async def test_add_with_several_keeps_primary_first(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Gutters", assigned_persons=[ANNA, KEVIN, ANNA])
    assert task["assigned_persons"] == [ANNA, KEVIN]
    assert task["assigned_person"] == ANNA


async def test_assigned_person_alone_keeps_its_old_meaning(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Bins", assigned_persons=[ANNA, KEVIN])
    await store.async_update_task(task["id"], assigned_person=MIA)
    t = store.get_task(task["id"])
    assert t["assigned_person"] == MIA
    assert t["assigned_persons"] == [MIA]

    await store.async_update_task(task["id"], assigned_person=None)
    t = store.get_task(task["id"])
    assert t["assigned_person"] is None
    assert t["assigned_persons"] == []


async def test_update_list_moves_primary(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Plants", assigned_person=ANNA)
    await store.async_update_task(task["id"], assigned_persons=[KEVIN, ANNA])
    t = store.get_task(task["id"])
    assert t["assigned_person"] == KEVIN
    assert t["assigned_persons"] == [KEVIN, ANNA]


async def test_get_tasks_person_filter_matches_any_assignee(hass: HomeAssistant, mock_config_entry, store) -> None:
    await store.async_add_task("Shared", assigned_persons=[ANNA, KEVIN])
    await store.async_add_task("Anna only", assigned_person=ANNA)
    result = await hass.services.async_call(
        DOMAIN, "get_tasks", {"list_name": "Test List", "assigned_person": KEVIN},
        blocking=True, return_response=True,
    )
    assert [t["title"] for t in result["tasks"]] == ["Shared"]
    assert result["tasks"][0]["assigned_persons"] == [ANNA, KEVIN]


async def test_services_take_comma_separated_persons(hass: HomeAssistant, mock_config_entry, store) -> None:
    await hass.services.async_call(
        DOMAIN, "add_task",
        {"list_name": "Test List", "title": "Tax", "assigned_persons": f"{ANNA}, {KEVIN}"},
        blocking=True,
    )
    task = next(t for t in store.tasks if t["title"] == "Tax")
    assert task["assigned_persons"] == [ANNA, KEVIN]
    await hass.services.async_call(
        DOMAIN, "update_task",
        {"list_name": "Test List", "task_title": "Tax", "assigned_persons": MIA},
        blocking=True,
    )
    task = store.get_task(task["id"])
    assert task["assigned_persons"] == [MIA]
    assert task["assigned_person"] == MIA


async def test_assigned_event_reports_who_was_added(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Dishes", assigned_person=ANNA)
    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_assigned", events.append)
    await store.async_update_task(task["id"], assigned_persons=[ANNA, KEVIN])
    await hass.async_block_till_done()
    assert len(events) == 1
    data = events[0].data
    assert data["assigned_person"] == ANNA          # primary unchanged
    assert data["assigned_persons"] == [ANNA, KEVIN]
    assert data["previous_persons"] == [ANNA]
    assert data["added_persons"] == [KEVIN]


async def test_reminder_style_event_data_lists_everyone(hass: HomeAssistant, mock_config_entry, store) -> None:
    from custom_components.home_tasks.__init__ import _build_event_data

    task = await store.async_add_task("Bins", assigned_persons=[ANNA, KEVIN])
    data = _build_event_data(hass, mock_config_entry.entry_id, task)
    assert data["assigned_person"] == ANNA
    assert data["assigned_persons"] == [ANNA, KEVIN]


async def test_task_stored_before_the_field_existed(hass: HomeAssistant, mock_config_entry, store) -> None:
    from custom_components.home_tasks.store import task_assignees

    assert task_assignees({"assigned_person": ANNA}) == [ANNA]
    assert task_assignees({}) == []


@pytest.mark.parametrize("bad", ["person.anna", [1], [f"person.p{i}" for i in range(11)]])
async def test_rejects_invalid_lists(hass: HomeAssistant, mock_config_entry, store, bad) -> None:
    task = await store.async_add_task("X")
    with pytest.raises(ValueError):
        await store.async_update_task(task["id"], assigned_persons=bad)


async def test_ws_update_task_accepts_list(hass: HomeAssistant, hass_ws_client, mock_config_entry, store) -> None:
    task = await store.async_add_task("WS")
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1, "type": "home_tasks/update_task", "list_id": mock_config_entry.entry_id,
        "task_id": task["id"], "assigned_persons": [KEVIN, MIA],
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    t = store.get_task(task["id"])
    assert t["assigned_persons"] == [KEVIN, MIA]
    assert t["assigned_person"] == KEVIN
