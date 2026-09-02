"""Live tests for the picture library — the part where a mistake costs money.

A generated picture outlives the task it was made for (#56), so a recreated or
retyped task takes the stored one instead of paying for a new one. Proving
that offline only proves the mock; here it runs against the real store.

Nothing in this file may cause a real generation. The ai_task entity handed to
every call does not exist, so the reuse path is the only way these tests can
pass — and a regression that reaches the provider fails them with an error
instead of a bill.

Setup:  HT_NATIVE_LIST_NAME (and HT_NATIVE_LIST_NAME_2 for the cross-list half).
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from .ws_client import HAWebSocketClient, WSError

pytestmark = [pytest.mark.live]

# Deliberately not an entity: a call that reaches the provider fails loudly.
NO_SUCH_AI = "ai_task.zz_definitely_not_configured"
# A public path shaped like ours, so it counts as a real picture. The file
# itself need not exist - nothing here loads it.
PICTURE = "/local/home_tasks/zz_live_reuse_probe.png"
TITLE = "ZZ picture that outlives its task"


async def _generate(ws: HAWebSocketClient, list_id: str, task_id: str) -> dict:
    return await ws.send_command(
        "home_tasks/generate_task_image",
        entry_id=list_id, task_id=task_id, entity_id=NO_SUCH_AI,
    )


@asynccontextmanager
async def sharing(ws: HAWebSocketClient, list_id: str, on: bool):
    """Set the list's image sharing and put it back afterwards."""
    lists = (await ws.send_command("home_tasks/get_lists"))["lists"]
    before = next((l.get("share_images", True) for l in lists if l["id"] == list_id), True)
    await ws.send_command(
        "home_tasks/set_list_settings", list_id=list_id, share_images=on
    )
    try:
        yield
    finally:
        try:
            await ws.send_command(
                "home_tasks/set_list_settings", list_id=list_id, share_images=before
            )
        except Exception as err:  # noqa: BLE001
            print(f"[sharing teardown] could not restore {list_id}: {err}")


@pytest.mark.live_websocket
async def test_a_picture_outlives_the_task_it_was_made_for(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """The recurrence deletes and recreates a task; the picture must come back
    without anyone paying for it twice."""
    list_id = clean_native_list
    async with sharing(ws_client, list_id, True):
        first = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title=TITLE
        )
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=list_id, task_id=first["id"], image_url=PICTURE,
        )
        await ws_client.send_command(
            "home_tasks/delete_task", list_id=list_id, task_id=first["id"]
        )

        again = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title=TITLE
        )
        result = await _generate(ws_client, list_id, again["id"])

        assert result["task"]["image_url"].split("?")[0] == PICTURE, (
            "the stored picture came back; no provider was asked"
        )


@pytest.mark.live_websocket
async def test_a_retyped_title_is_served_too(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Plural or singular is the same chore; a different word is not."""
    list_id = clean_native_list
    async with sharing(ws_client, list_id, True):
        first = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ take out the bins"
        )
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=list_id, task_id=first["id"], image_url=PICTURE,
        )
        await ws_client.send_command(
            "home_tasks/delete_task", list_id=list_id, task_id=first["id"]
        )

        retyped = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ take out the bin"
        )
        result = await _generate(ws_client, list_id, retyped["id"])
        assert result["task"]["image_url"].split("?")[0] == PICTURE

        # A different word is a different chore: nothing to reuse, so the call
        # has to reach for the provider - which is not there, on purpose.
        other = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ take out the recycling"
        )
        with pytest.raises(WSError):
            await _generate(ws_client, list_id, other["id"])


@pytest.mark.live_websocket
async def test_a_list_that_keeps_to_itself_is_not_served_from_the_library(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Three children, three pictures for the same chore: with sharing off the
    list neither takes from the pool nor adds to it."""
    list_id = clean_native_list
    async with sharing(ws_client, list_id, True):
        shared = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title=TITLE
        )
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=list_id, task_id=shared["id"], image_url=PICTURE,
        )
        await ws_client.send_command(
            "home_tasks/delete_task", list_id=list_id, task_id=shared["id"]
        )

    async with sharing(ws_client, list_id, False):
        own = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title=TITLE
        )
        # Nothing may be handed over, so the call reaches for the provider and
        # fails on the entity that is not there.
        with pytest.raises(WSError):
            await _generate(ws_client, list_id, own["id"])


@pytest.mark.live_websocket_two_lists
async def test_the_picture_crosses_to_another_list(
    ws_client: HAWebSocketClient, clean_native_list: str, native_list_id_secondary: str
) -> None:
    """Same chore on two lists, one picture - as long as both take part."""
    first_list, second_list = clean_native_list, native_list_id_secondary
    async with sharing(ws_client, first_list, True), sharing(ws_client, second_list, True):
        source = await ws_client.send_command(
            "home_tasks/add_task", list_id=first_list, title=TITLE
        )
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=first_list, task_id=source["id"], image_url=PICTURE,
        )

        elsewhere = await ws_client.send_command(
            "home_tasks/add_task", list_id=second_list, title=TITLE
        )
        try:
            result = await _generate(ws_client, second_list, elsewhere["id"])
            assert result["task"]["image_url"].split("?")[0] == PICTURE
        finally:
            await ws_client.send_command(
                "home_tasks/delete_task", list_id=second_list, task_id=elsewhere["id"]
            )
