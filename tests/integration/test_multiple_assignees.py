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


async def test_a_copy_keeps_everyone_unless_made_for_someone_else(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    task = await store.async_add_task("Gutters", assigned_persons=[ANNA, KEVIN])
    copy = await store.async_duplicate_task(task["id"], assigned_person=ANNA)
    assert (copy["assigned_person"], copy["assigned_persons"]) == (ANNA, [ANNA, KEVIN])
    other = await store.async_duplicate_task(task["id"], assigned_person=MIA)
    assert (other["assigned_person"], other["assigned_persons"]) == (MIA, [MIA])
    nobody = await store.async_duplicate_task(task["id"], assigned_person=None)
    assert nobody["assigned_persons"] == []


# ---------------------------------------------------------------------------
# Linked lists: the provider gets the primary, the overlay keeps everyone
# ---------------------------------------------------------------------------

async def test_a_linked_list_keeps_everyone_in_the_overlay(hass: HomeAssistant, linked_list) -> None:
    from tests.integration.linked_list_helpers import LIST_NAME, call, overlay

    entry, adapter = linked_list
    await call(hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench", assigned_persons=f"{KEVIN},{ANNA}")
    assert adapter.updated[-1][1]["assigned_person"] == KEVIN
    assert "assigned_persons" not in adapter.updated[-1][1]
    stored = overlay(hass, entry).get_overlay("uid-1")
    assert (stored["assigned_person"], stored["assigned_persons"]) == (KEVIN, [KEVIN, ANNA])


async def test_a_bad_list_on_a_linked_list_never_reaches_the_provider(hass: HomeAssistant, linked_list) -> None:
    from tests.integration.linked_list_helpers import LIST_NAME, call

    _entry, adapter = linked_list
    with pytest.raises(Exception):
        await call(hass, "add_task", list_name=LIST_NAME, title="Too many",
                   assigned_persons=[f"person.p{i}" for i in range(11)])
    assert not adapter.created


async def test_a_linked_copy_keeps_everyone(hass: HomeAssistant, linked_list) -> None:
    from custom_components.home_tasks.websocket_api import async_duplicate_external_task
    from tests.integration.linked_list_helpers import EXT_ENTITY, overlay

    entry, adapter = linked_list
    await overlay(hass, entry).async_set_overlay("uid-1", assigned_persons=[ANNA, KEVIN])
    new_uid = await async_duplicate_external_task(hass, EXT_ENTITY, "uid-1", ANNA)
    assert adapter.created[-1]["assigned_person"] == ANNA
    assert overlay(hass, entry).get_overlay(new_uid)["assigned_persons"] == [ANNA, KEVIN]


async def test_history_of_a_task_born_shared_names_everyone(hass: HomeAssistant, mock_config_entry, store) -> None:
    shared = await store.async_add_task("Gutters", assigned_persons=[ANNA, KEVIN])
    assert [(h.get("field"), h.get("to")) for h in shared["history"]] == [
        (None, None), ("assigned_person", ANNA), ("assigned_persons", [ANNA, KEVIN]),
    ]
    alone = await store.async_add_task("Bins", assigned_person=ANNA)
    assert [h.get("field") for h in alone["history"]] == [None, "assigned_person"]


async def test_the_primary_counts_towards_the_limit(hass: HomeAssistant, mock_config_entry, store) -> None:
    task = await store.async_add_task("Party")
    ten = [f"person.p{i}" for i in range(10)]
    with pytest.raises(ValueError, match="at most 10"):
        await store.async_update_task(task["id"], assigned_persons=ten, assigned_person=MIA)
    assert store.get_task(task["id"])["assigned_persons"] == []


async def test_linked_list_events_carry_everyone(hass: HomeAssistant, linked_list) -> None:
    from custom_components.home_tasks.websocket_api import async_update_external_task
    from tests.integration.linked_list_helpers import EXT_ENTITY, LIST_NAME, call, overlay

    entry, _adapter = linked_list
    created, completed = [], []
    hass.bus.async_listen(f"{DOMAIN}_task_created", created.append)
    hass.bus.async_listen(f"{DOMAIN}_task_completed", completed.append)
    await call(hass, "add_task", list_name=LIST_NAME, title="Gutters", assigned_persons=[ANNA, KEVIN])
    assert (created[-1].data["assigned_person"], created[-1].data["assigned_persons"]) == (ANNA, [ANNA, KEVIN])

    await overlay(hass, entry).async_set_overlay("uid-1", assigned_persons=[KEVIN, MIA])
    await async_update_external_task(hass, EXT_ENTITY, "uid-1", {"completed": True})
    await hass.async_block_till_done()
    assert completed[-1].data["assigned_persons"] == [KEVIN, MIA]
