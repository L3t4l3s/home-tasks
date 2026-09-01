"""Integration tests for the background image-generation queue (issue #55).

The queue's whole point is pacing and durability, so these tests drive it
directly rather than through the timers: they assert what it enqueues, what
it does with a provider call, and — most importantly — that a restart neither
loses the backlog nor lets a running cooldown lapse.
"""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from custom_components.home_tasks.image_queue import ImageQueue

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


async def _queue(hass: HomeAssistant, **config) -> ImageQueue:
    q = ImageQueue(hass)
    await q.async_load()
    if config:
        await q.async_configure(**config)
    return q


def _patched_generation(reused: bool = False, fail: bool = False):
    """Stand in for the generation core, reporting reuse or failure."""
    if fail:
        return patch(
            "custom_components.home_tasks.websocket_api.async_generate_task_image",
            new=AsyncMock(side_effect=RuntimeError("provider down")),
        )
    return patch(
        "custom_components.home_tasks.websocket_api.async_generate_task_image",
        new=AsyncMock(return_value={"task": {"id": "x"}, "reused": reused}),
    )


# --- scanning ---------------------------------------------------------------


async def test_scan_only_picks_up_opted_in_lists(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """A list that did not ask for background generation is left alone."""
    await store.async_add_task("Needs a picture")
    q = await _queue(hass)

    assert await q.async_scan() == 0, "opt-in is off by default"

    await store.async_set_settings(auto_generate_images=True)
    assert await q.async_scan() == 1
    assert q.queue[0]["title"] == "Needs a picture"
    assert q.queue[0]["list_id"] == mock_config_entry.entry_id


async def test_scan_skips_completed_and_illustrated_tasks(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Only open tasks without an image are worth a provider call."""
    await store.async_set_settings(auto_generate_images=True)
    open_one = await store.async_add_task("Open, no image")
    done = await store.async_add_task("Done")
    await store.async_update_task(done["id"], completed=True)
    illustrated = await store.async_add_task("Has one")
    await store.async_update_task(illustrated["id"], image_url="/local/home_tasks/x.png")

    q = await _queue(hass)
    assert await q.async_scan() == 1
    assert [e["task_id"] for e in q.queue] == [open_one["id"]]


async def test_scan_does_not_queue_the_same_task_twice(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Scans repeat every 15 minutes; the queue must not grow every time."""
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("Once")

    q = await _queue(hass)
    assert await q.async_scan() == 1
    assert await q.async_scan() == 0
    assert len(q.queue) == 1


# --- pacing -----------------------------------------------------------------


async def test_a_provider_call_starts_the_cooldown(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("Paint me")
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.test",
                     min_minutes=20, max_minutes=35)

    with _patched_generation(reused=False):
        await q.async_tick()

    assert q.queue == [], "the task was taken off the queue"
    until = q.cooldown_until
    assert until is not None
    remaining = until - dt_util.utcnow()
    assert timedelta(minutes=19) < remaining <= timedelta(minutes=35)


async def test_a_local_reuse_does_not_consume_the_cooldown(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Reusing an existing image costs the provider nothing.

    Pacing it would trickle a list of duplicates through at one task per half
    hour for no reason.
    """
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("Same title")
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.test")

    with _patched_generation(reused=True):
        await q.async_tick()

    assert q.cooldown_until is None


async def test_a_failed_call_still_consumes_the_cooldown(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """A failure has usually reached the provider — retrying at once hammers it."""
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("Will fail")
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.test")

    with _patched_generation(fail=True):
        await q.async_tick()

    assert q.cooldown_until is not None


async def test_the_cooldown_blocks_the_next_task(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Only one provider request at a time, and only after the pause."""
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("First")
    await store.async_add_task("Second")
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.test")

    with _patched_generation(reused=False) as gen:
        await q.async_tick()
        assert gen.await_count == 1
        await q.async_tick()
        assert gen.await_count == 1, "second task must wait for the cooldown"

    assert len(q.queue) == 1


# --- durability -------------------------------------------------------------


async def test_queue_and_cooldown_survive_a_restart(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Restarting must not be a way around the pacing."""
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("First")
    await store.async_add_task("Second")
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.test")
    with _patched_generation(reused=False):
        await q.async_tick()
    before_queue = q.queue
    before_cooldown = q.cooldown_until

    # A fresh instance is what a restart produces.
    restarted = ImageQueue(hass)
    await restarted.async_load()

    assert restarted.queue == before_queue
    assert restarted.cooldown_until == before_cooldown
    assert restarted.config["enabled"] is True
    assert restarted.config["ai_task_entity_id"] == "ai_task.test"

    with _patched_generation(reused=False) as gen:
        await restarted.async_tick()
        assert gen.await_count == 0, "the pending cooldown still applies after a restart"


async def test_disabled_queue_does_nothing(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_set_settings(auto_generate_images=True)
    await store.async_add_task("Not now")
    q = await _queue(hass, enabled=False)

    with _patched_generation(reused=False) as gen:
        await q.async_tick()
        assert gen.await_count == 0
    assert q.queue == []


# --- configuration ----------------------------------------------------------


async def test_configure_keeps_untouched_fields(hass: HomeAssistant) -> None:
    q = await _queue(hass, enabled=True, ai_task_entity_id="ai_task.a", prompt_prefix="Icon of")
    await q.async_configure(enabled=False)

    cfg = q.config
    assert cfg["enabled"] is False
    assert cfg["ai_task_entity_id"] == "ai_task.a"
    assert cfg["prompt_prefix"] == "Icon of"


async def test_configure_rejects_an_inverted_range(hass: HomeAssistant) -> None:
    q = await _queue(hass)
    with pytest.raises(ValueError):
        await q.async_configure(min_minutes=40, max_minutes=10)


async def test_service_configures_the_queue(hass: HomeAssistant, mock_config_entry) -> None:
    """The service is the documented way in — it must reach the live queue."""
    from custom_components.home_tasks.image_queue import async_get_image_queue

    queue = async_get_image_queue(hass)
    assert queue is not None, "registered during setup"
    await queue.async_load()

    await hass.services.async_call(
        DOMAIN,
        "configure_image_queue",
        {"enabled": True, "ai_task_entity_id": "ai_task.svc", "min_minutes": 5, "max_minutes": 9},
        blocking=True,
    )

    cfg = async_get_image_queue(hass).config
    assert cfg["enabled"] is True
    assert cfg["ai_task_entity_id"] == "ai_task.svc"
    assert (cfg["min_minutes"], cfg["max_minutes"]) == (5, 9)
