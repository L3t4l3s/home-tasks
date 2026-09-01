"""Integration tests for the background image queue (issue #55).

The queue is deliberately unpaced — switching the option on should fill a
list with pictures in minutes. What keeps it safe is that a task is tried
exactly once: a failure is recorded, shown as a placeholder, and never
retried until the user asks again. These tests pin down both halves.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant

from custom_components.home_tasks.image_queue import (
    FAILED_IMAGE_URL,
    PENDING_IMAGE_URL,
    ImageQueue,
    async_get_image_queue,
)

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


async def _queue(hass: HomeAssistant, **config) -> ImageQueue:
    """The queue the integration registered - not a second instance.

    Two instances would share one storage key and fight over it, and the
    registered one is the only one listening for task_created.
    """
    q = async_get_image_queue(hass)
    assert q is not None
    await q.async_load()
    if config:
        await q.async_sync_config(**config)
    return q


def _generation(fail: bool = False, reused: bool = False, store=None):
    """Stand in for the generation core.

    Pass *store* to have it write a real image like the real thing does —
    without that the task keeps the waiting placeholder and every later scan
    would (correctly) queue it again.
    """
    if fail:
        return patch(
            "custom_components.home_tasks.websocket_api.async_generate_task_image",
            new=AsyncMock(side_effect=RuntimeError("provider down")),
        )

    async def _run(hass, connection, *, task_id, **kwargs):
        if store is not None:
            await store.async_update_task(task_id, image_url="/local/home_tasks/gen.png")
        return {"task": {"id": task_id}, "reused": reused}

    return patch(
        "custom_components.home_tasks.websocket_api.async_generate_task_image",
        new=AsyncMock(side_effect=_run),
    )


# --- scanning ---------------------------------------------------------------


async def test_scan_only_picks_up_opted_in_lists(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """The card's own auto-generate switch is the trigger, nothing else."""
    await store.async_add_task("Needs a picture")
    q = await _queue(hass)

    assert await q.async_scan() == 0, "off by default"

    await store.async_set_settings(auto_generate_images=True)
    assert await q.async_scan() == 1
    assert q.queue[0]["title"] == "Needs a picture"
    assert q.queue[0]["list_id"] == mock_config_entry.entry_id


async def test_scan_skips_completed_and_illustrated_tasks(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    open_one = await store.async_add_task("Open, no image")
    done = await store.async_add_task("Done")
    await store.async_update_task(done["id"], completed=True)
    illustrated = await store.async_add_task("Has one")
    await store.async_update_task(illustrated["id"], image_url="/local/home_tasks/x.png")
    await store.async_set_settings(auto_generate_images=True)

    q = await _queue(hass)
    assert await q.async_scan() == 1
    assert [e["task_id"] for e in q.queue] == [open_one["id"]]


async def test_scan_does_not_queue_the_same_task_twice(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_add_task("Once")
    await store.async_set_settings(auto_generate_images=True)

    q = await _queue(hass)
    assert await q.async_scan() == 1
    assert await q.async_scan() == 0
    assert len(q.queue) == 1


async def test_queued_tasks_show_the_generating_placeholder(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """A waiting list should look busy, not broken."""
    task = await store.async_add_task("Waiting")
    await store.async_set_settings(auto_generate_images=True)

    q = await _queue(hass)
    await q.async_scan()

    assert store.get_task(task["id"])["image_url"] == PENDING_IMAGE_URL


# --- working the queue ------------------------------------------------------


async def test_the_queue_is_worked_empty_in_one_pass(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """No pacing: turning it on fills the list, it does not trickle."""
    for i in range(4):
        await store.async_add_task(f"Task {i}")
    await store.async_set_settings(auto_generate_images=True)

    q = await _queue(hass, ai_task_entity_id="ai_task.test")
    with _generation() as gen:
        await q.async_run()

    assert gen.await_count == 4
    assert q.queue == []


async def test_a_failure_is_marked_and_not_retried(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """One attempt per task. The placeholder makes the failure visible."""
    task = await store.async_add_task("Will fail")
    await store.async_set_settings(auto_generate_images=True)
    q = await _queue(hass, ai_task_entity_id="ai_task.test")

    with _generation(fail=True) as gen:
        await q.async_run()
        assert gen.await_count == 1
        # A later scan must not pick it up again.
        await q.async_run()
        assert gen.await_count == 1

    assert store.get_task(task["id"])["image_url"] == FAILED_IMAGE_URL
    assert q.queue == []
    assert len(q.failed) == 1


async def test_switching_the_list_on_again_retries_the_failures(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Off and on again is the way to ask for another attempt."""
    task = await store.async_add_task("Will fail once")
    await store.async_set_settings(auto_generate_images=True)
    queue = async_get_image_queue(hass)
    await queue.async_load()
    await queue.async_sync_config(ai_task_entity_id="ai_task.test")

    with _generation(fail=True):
        await queue.async_run()
    assert len(queue.failed) == 1

    client = await hass_ws_client(hass)
    # Switching on clears the marks and kicks the queue right away, so the
    # retry happens inside this patch.
    with _generation() as gen:
        for value in (False, True):
            await client.send_json({
                "id": 500 + int(value),
                "type": "home_tasks/set_list_settings",
                "list_id": mock_config_entry.entry_id,
                "auto_generate_images": value,
            })
            assert (await client.receive_json())["success"] is True
        await hass.async_block_till_done()

        assert queue.failed == [], "switching on clears the marks"
        assert gen.await_count == 1, "and tries the task again without being asked"
    assert store.get_task(task["id"])["image_url"] != FAILED_IMAGE_URL


async def test_a_new_task_is_queued_without_waiting_for_a_scan(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """The task_created event feeds the queue directly."""
    await store.async_set_settings(auto_generate_images=True)
    queue = async_get_image_queue(hass)
    await queue.async_load()
    await queue.async_sync_config(ai_task_entity_id="ai_task.test")

    with _generation() as gen:
        await store.async_add_task("Fresh")
        await hass.async_block_till_done()
        assert gen.await_count == 1


async def test_toggling_the_switch_does_not_duplicate_jobs(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Flipping the option repeatedly must not queue a task several times."""
    await store.async_add_task("Toggle me")
    q = await _queue(hass, ai_task_entity_id="ai_task.test")
    client = await hass_ws_client(hass)

    with _generation(store=store) as gen:
        for i, value in enumerate([True, False, True, False, True]):
            await client.send_json({
                "id": 540 + i,
                "type": "home_tasks/set_list_settings",
                "list_id": mock_config_entry.entry_id,
                "auto_generate_images": value,
            })
            assert (await client.receive_json())["success"] is True
        await hass.async_block_till_done()
        await q.async_run()

    # Switching on generates straight away, so the task is done after the
    # first "on" — the later ones must neither queue it again nor pay for a
    # second picture.
    assert gen.await_count == 1, "one task, one generation"
    assert q.queue == []


async def test_switching_off_clears_the_queue_for_that_list(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Off means off: no pending generation, no leftover placeholder.

    A second list that is still on keeps its own work.
    """
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    other = MockConfigEntry(domain=DOMAIN, data={"name": "Other"}, title="Other")
    other.add_to_hass(hass)
    await hass.config_entries.async_setup(other.entry_id)
    await hass.async_block_till_done()
    other_store = hass.data[DOMAIN][other.entry_id]

    mine = await store.async_add_task("Mine")
    theirs = await other_store.async_add_task("Theirs")
    await store.async_set_settings(auto_generate_images=True)
    await other_store.async_set_settings(auto_generate_images=True)

    q = await _queue(hass, ai_task_entity_id="ai_task.test")
    await q.async_scan()
    assert len(q.queue) == 2
    assert store.get_task(mine["id"])["image_url"] == PENDING_IMAGE_URL

    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 545,
        "type": "home_tasks/set_list_settings",
        "list_id": mock_config_entry.entry_id,
        "auto_generate_images": False,
    })
    assert (await client.receive_json())["success"] is True

    assert [e["list_id"] for e in q.queue] == [other.entry_id]
    assert store.get_task(mine["id"])["image_url"] is None, "placeholder removed"
    assert other_store.get_task(theirs["id"])["image_url"] == PENDING_IMAGE_URL

    with _generation() as gen:
        await q.async_run()
        assert gen.await_count == 1, "only the list that is still on"


async def test_a_stale_job_is_dropped_instead_of_generated(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """The worker re-checks the switch before spending a provider call."""
    task = await store.async_add_task("Stale")
    await store.async_set_settings(auto_generate_images=True)
    q = await _queue(hass, ai_task_entity_id="ai_task.test")
    await q.async_scan()
    assert len(q.queue) == 1

    # Switched off directly on the store, so the queue was never told.
    await store.async_set_settings(auto_generate_images=False)

    with _generation() as gen:
        await q.async_run()
        assert gen.await_count == 0
    assert q.queue == []
    assert store.get_task(task["id"])["image_url"] is None


async def test_cancelling_a_job_clears_its_placeholder(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    task = await store.async_add_task("Cancel and clear")
    await store.async_set_settings(auto_generate_images=True)
    q = await _queue(hass)
    await q.async_scan()
    assert store.get_task(task["id"])["image_url"] == PENDING_IMAGE_URL

    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 546,
        "type": "home_tasks/cancel_image_queue",
        "jobs": [{"list_id": mock_config_entry.entry_id, "task_id": task["id"]}],
    })
    assert (await client.receive_json())["success"] is True

    assert store.get_task(task["id"])["image_url"] is None


# --- durability -------------------------------------------------------------


async def test_the_queue_survives_a_restart(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_add_task("First")
    await store.async_add_task("Second")
    await store.async_set_settings(auto_generate_images=True)
    q = await _queue(hass, ai_task_entity_id="ai_task.test")
    await q.async_scan()
    before = q.queue

    restarted = ImageQueue(hass)
    await restarted.async_load()

    assert restarted.queue == before
    assert restarted.config["ai_task_entity_id"] == "ai_task.test"


# --- the editor's queue panel ----------------------------------------------


async def test_websocket_reports_and_cancels_jobs(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Cancelling also stops the switch that queued the job.

    Otherwise the next scan would put it straight back and the cancel button
    would look broken.
    """
    task = await store.async_add_task("Cancel me")
    await store.async_set_settings(auto_generate_images=True)
    queue = async_get_image_queue(hass)
    await queue.async_load()
    await queue.async_scan()

    client = await hass_ws_client(hass)
    await client.send_json({"id": 510, "type": "home_tasks/get_image_queue"})
    msg = await client.receive_json()
    assert msg["success"] is True
    assert [e["task_id"] for e in msg["result"]["queue"]] == [task["id"]]

    await client.send_json({
        "id": 511,
        "type": "home_tasks/cancel_image_queue",
        "jobs": [{"list_id": mock_config_entry.entry_id, "task_id": task["id"]}],
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg
    assert msg["result"]["removed"] == 1

    assert queue.queue == []
    assert store.get_settings()["auto_generate_images"] is False, (
        "the trigger has to go with it"
    )


async def test_websocket_syncs_the_cards_generation_settings(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    """The queue has no dashboard to read the ai_task entity from."""
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 520,
        "type": "home_tasks/sync_image_config",
        "ai_task_entity_id": "ai_task.from_card",
        "prompt_prefix": "Minimalist icon of",
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    cfg = async_get_image_queue(hass).config
    assert cfg["ai_task_entity_id"] == "ai_task.from_card"
    assert cfg["prompt_prefix"] == "Minimalist icon of"


# --- placeholders are not pictures ------------------------------------------


async def test_a_placeholder_is_never_reused_for_another_task(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Same-title reuse must not hand the spinner to the next task."""
    from homeassistant.core import SupportsResponse

    waiting = await store.async_add_task("Zimmer aufraeumen")
    await store.async_update_task(waiting["id"], image_url=PENDING_IMAGE_URL)
    second = await store.async_add_task("Zimmer aufraeumen")

    hass.services.async_register(
        "ai_task",
        "generate_image",
        AsyncMock(return_value={"media_source_id": "media-source://media_source/g.png"}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    client = await hass_ws_client(hass)
    with patch(
        "custom_components.home_tasks.websocket_api._save_image_to_public_media",
        new=AsyncMock(return_value="/local/home_tasks/g.png"),
    ):
        await client.send_json({
            "id": 530,
            "type": "home_tasks/generate_task_image",
            "entry_id": mock_config_entry.entry_id,
            "task_id": second["id"],
            "entity_id": "ai_task.test",
        })
        msg = await client.receive_json()

    assert msg["success"] is True, msg
    assert msg["result"]["task"]["image_url"].startswith("/local/home_tasks/g.png")
