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


async def test_a_near_identical_title_is_served_too(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    library = async_get_image_library(hass)
    await library.async_load()
    generate = _register_provider(hass)
    client = await hass_ws_client(hass)

    a = await store.async_add_task("Book a blood draw")
    msg = await _generate(hass, client, 710, mock_config_entry.entry_id, a["id"])
    url = msg["result"]["task"]["image_url"]
    await store.async_delete_task(a["id"])

    b = await store.async_add_task("Book a blood test")
    msg = await _generate(hass, client, 711, mock_config_entry.entry_id, b["id"])
    assert msg["result"]["task"]["image_url"] == url
    assert generate.await_count == 1


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
