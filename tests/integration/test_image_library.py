"""The image library in use (issue #56).

Covers what the matching unit tests cannot: that a picture survives the task
it was made for, that removing a picture is taken as a rejection, and that a
list which keeps its images to itself is not served from the shared pool.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant, SupportsResponse

from custom_components.home_tasks.image_library import async_get_image_library

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


def _register_provider(hass: HomeAssistant) -> AsyncMock:
    generate = AsyncMock(return_value={"media_source_id": "media-source://media_source/g.png"})
    hass.services.async_register(
        "ai_task", "generate_image", generate, supports_response=SupportsResponse.OPTIONAL
    )
    return generate


async def _generate(hass, client, msg_id, entry_id, task_id, url="/local/home_tasks/g.png"):
    with patch(
        "custom_components.home_tasks.websocket_api._save_image_to_public_media",
        new=AsyncMock(return_value=url),
    ):
        await client.send_json({
            "id": msg_id,
            "type": "home_tasks/generate_task_image",
            "entry_id": entry_id,
            "task_id": task_id,
            "entity_id": "ai_task.test",
        })
        return await client.receive_json()


async def test_a_picture_outlives_the_task(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """The whole point: a recreated task does not pay for the same image twice."""
    library = async_get_image_library(hass)
    await library.async_load()
    generate = _register_provider(hass)
    client = await hass_ws_client(hass)

    first = await store.async_add_task("Take out the bins")
    msg = await _generate(hass, client, 700, mock_config_entry.entry_id, first["id"])
    assert msg["success"] is True, msg
    url = msg["result"]["task"]["image_url"]
    assert generate.await_count == 1

    # The recurrence deletes and recreates it — nothing with that title is
    # left to copy an image from.
    await store.async_delete_task(first["id"])
    again = await store.async_add_task("Take out the bins")

    msg = await _generate(hass, client, 701, mock_config_entry.entry_id, again["id"])
    assert msg["success"] is True, msg
    assert msg["result"]["task"]["image_url"] == url
    assert generate.await_count == 1, "no second provider call"


async def test_a_retyped_title_is_served_too(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """An inflected ending is the only difference a title may have.

    Typing the chore back in slightly differently should not cost a picture;
    a different word would be a different chore.
    """
    library = async_get_image_library(hass)
    await library.async_load()
    generate = _register_provider(hass)
    client = await hass_ws_client(hass)

    a = await store.async_add_task("Take out the bins")
    msg = await _generate(hass, client, 710, mock_config_entry.entry_id, a["id"])
    url = msg["result"]["task"]["image_url"]
    await store.async_delete_task(a["id"])

    b = await store.async_add_task("take out the bin")
    msg = await _generate(hass, client, 711, mock_config_entry.entry_id, b["id"])
    assert msg["result"]["task"]["image_url"] == url
    assert generate.await_count == 1

    # ...but a different word is a different task, and gets its own picture.
    c = await store.async_add_task("take out the recycling")
    await _generate(hass, client, 712, mock_config_entry.entry_id, c["id"],
                    url="/local/home_tasks/other.png")
    assert generate.await_count == 2


async def test_removing_an_image_rejects_it(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """Deleting a picture must not hand the same one back next time."""
    library = async_get_image_library(hass)
    await library.async_load()
    generate = _register_provider(hass)
    client = await hass_ws_client(hass)

    task = await store.async_add_task("Water the plants")
    msg = await _generate(hass, client, 720, mock_config_entry.entry_id, task["id"])
    url = msg["result"]["task"]["image_url"]
    assert library.find("Water the plants") == url

    await client.send_json({
        "id": 721,
        "type": "home_tasks/update_task",
        "list_id": mock_config_entry.entry_id,
        "task_id": task["id"],
        "image_url": None,
    })
    assert (await client.receive_json())["success"] is True

    assert library.find("Water the plants") is None, "the rejected picture is forgotten"

    await _generate(hass, client, 722, mock_config_entry.entry_id, task["id"],
                    url="/local/home_tasks/second.png")
    assert generate.await_count == 2, "a fresh one is generated"


async def test_a_list_that_keeps_to_itself_is_not_served_from_the_library(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """share_images off means out of the pool in both directions."""
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    kid = MockConfigEntry(domain=DOMAIN, data={"name": "Kid"}, title="Kid")
    kid.add_to_hass(hass)
    await hass.config_entries.async_setup(kid.entry_id)
    await hass.async_block_till_done()
    kid_store = hass.data[DOMAIN][kid.entry_id]
    await kid_store.async_set_settings(share_images=False)

    library = async_get_image_library(hass)
    await library.async_load()
    generate = _register_provider(hass)
    client = await hass_ws_client(hass)

    shared_task = await store.async_add_task("Zimmer aufräumen")
    msg = await _generate(hass, client, 730, mock_config_entry.entry_id, shared_task["id"])
    shared_url = msg["result"]["task"]["image_url"]
    await store.async_delete_task(shared_task["id"])

    own = await kid_store.async_add_task("Zimmer aufräumen")
    msg = await _generate(hass, client, 731, kid.entry_id, own["id"],
                          url="/local/home_tasks/own.png")
    assert msg["success"] is True, msg
    assert msg["result"]["task"]["image_url"] != shared_url
    assert generate.await_count == 2, "the opted-out list generates its own"

    # ...and it did not put its picture into the pool either.
    assert library.find("Zimmer aufräumen") == shared_url


async def test_one_provider_call_when_two_callers_want_the_same_picture(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """The card and the background queue both go for a task they just saw.

    Neither finds an existing image — the other has not finished yet — so the
    provider used to be paid twice for one picture.
    """
    import asyncio

    from custom_components.home_tasks.image_queue import async_get_image_queue

    library = async_get_image_library(hass)
    await library.async_load()
    queue = async_get_image_queue(hass)
    await queue.async_load()
    await queue.async_sync_config(ai_task_entity_id="ai_task.test")

    calls: list[str] = []
    slow = asyncio.Event()

    async def _gen(call):
        # A real provider takes seconds; hold every call until both are in.
        calls.append(call.data.get("instructions", ""))
        await slow.wait()
        return {"media_source_id": "media-source://media_source/g.png"}

    hass.services.async_register(
        "ai_task", "generate_image", _gen, supports_response=SupportsResponse.OPTIONAL
    )
    await store.async_set_settings(auto_generate_images=True)
    client = await hass_ws_client(hass)

    with patch(
        "custom_components.home_tasks.websocket_api._save_image_to_public_media",
        new=AsyncMock(return_value="/local/home_tasks/g.png"),
    ):
        task = await store.async_add_task("Banana")   # the queue hears this
        await client.send_json({                      # and the card asks too
            "id": 740,
            "type": "home_tasks/generate_task_image",
            "entry_id": mock_config_entry.entry_id,
            "task_id": task["id"],
            "entity_id": "ai_task.test",
        })
        await asyncio.sleep(0.05)                     # both are inside the call now
        slow.set()
        msg = await client.receive_json()
        await hass.async_block_till_done()

    assert msg["success"] is True, msg
    assert len(calls) == 1, f"one picture, one call: {calls}"
    assert store.get_task(task["id"])["image_url"].startswith("/local/home_tasks/g.png")


async def test_the_library_learns_pictures_that_were_already_there(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """Pictures made before the library existed must not be invisible.

    Otherwise the first generation after an update pays again for something
    that is already on disk.
    """
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    private = MockConfigEntry(domain=DOMAIN, data={"name": "Kid"}, title="Kid")
    private.add_to_hass(hass)
    await hass.config_entries.async_setup(private.entry_id)
    await hass.async_block_till_done()
    private_store = hass.data[DOMAIN][private.entry_id]
    await private_store.async_set_settings(share_images=False)

    old = await store.async_add_task("Bananas")
    await store.async_update_task(old["id"], image_url="/local/home_tasks/old.png")
    kept = await private_store.async_add_task("Zimmer aufräumen")
    await private_store.async_update_task(kept["id"], image_url="/local/home_tasks/kid.png")

    library = async_get_image_library(hass)
    await library.async_load()
    assert library.find("Bananas") is None, "nothing known yet"

    learned = await library.async_backfill()

    assert learned == 1
    assert library.find("Bananas") == "/local/home_tasks/old.png"
    assert library.find("Banana") == "/local/home_tasks/old.png", "and a retyped title too"
    assert library.find("Zimmer aufräumen") is None, "a list that keeps to itself stays out"


async def test_the_library_is_capped_and_evicts_the_oldest(
    hass: HomeAssistant, mock_config_entry
) -> None:
    from custom_components.home_tasks import image_library

    library = async_get_image_library(hass)
    await library.async_load()

    with patch.object(image_library, "MAX_ENTRIES", 3):
        for i in range(4):
            await library.async_remember(f"Task number {i}", f"/local/home_tasks/{i}.png")

    entries = library.entries
    assert len(entries) == 3
    assert "/local/home_tasks/0.png" not in entries, "least recently used goes first"


async def test_a_forced_regeneration_keeps_its_own_place_in_the_queue(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """The single-flight registration belongs to whoever made it.

    A caller that finished used to remove whatever was under its key - which,
    while a forced regeneration was running, was the forced one's. The next
    caller then found nothing in flight and paid for a third picture.
    """
    import asyncio

    from custom_components.home_tasks import websocket_api as ws

    library = async_get_image_library(hass)
    await library.async_load()

    calls: list[str] = []
    gates = [asyncio.Event(), asyncio.Event(), asyncio.Event()]

    async def _gen(call):
        gate = gates[min(len(calls), len(gates) - 1)]
        calls.append(call.data.get("instructions", ""))
        await gate.wait()
        return {"media_source_id": "media-source://media_source/g.png"}

    hass.services.async_register(
        "ai_task", "generate_image", _gen, supports_response=SupportsResponse.OPTIONAL
    )
    task = await store.async_add_task("Take out the bins")
    key = (mock_config_entry.entry_id, task["id"])

    def generate(**kw):
        return asyncio.create_task(ws.async_generate_task_image(
            hass, None, task_id=task["id"], entry_id=mock_config_entry.entry_id,
            ai_entity_id="ai_task.test", **kw,
        ))

    with patch(
        "custom_components.home_tasks.websocket_api._save_image_to_public_media",
        new=AsyncMock(return_value="/local/home_tasks/g.png"),
    ):
        automatic = generate()
        await asyncio.sleep(0.05)
        forced = generate(force=True)          # does not wait, registers its own
        await asyncio.sleep(0.05)

        gates[0].set()                          # the automatic one finishes...
        await automatic
        assert hass.data[ws.DATA_IMAGE_INFLIGHT].get(key) is not None, (
            "...and must not withdraw the forced one's registration"
        )

        third = generate()                      # should wait for the forced one
        await asyncio.sleep(0.05)
        gates[1].set()
        await asyncio.gather(forced, third)

    assert len(calls) == 2, f"one automatic and one forced generation, not three: {calls}"
