"""Unit tests for HomeTasksStore.async_duplicate_task."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from custom_components.home_tasks.const import MAX_IMAGE_URL_LENGTH

pytestmark = pytest.mark.unit


async def test_duplicate_is_independent_copy(hass: HomeAssistant, store) -> None:
    """The copy gets fresh ids and reset state, with no shared references."""
    src = await store.async_add_task("Original")
    await store.async_add_sub_task(src["id"], "sub one")
    source = store.get_task(src["id"])

    copy = await store.async_duplicate_task(src["id"])

    assert copy["id"] != source["id"]
    assert copy["title"] == "Original"
    assert copy["completed"] is False
    assert copy["completed_at"] is None
    assert copy["external_id"] is None
    assert copy["sync_source"] is None
    # sub-items copied with fresh ids, reset to open
    assert len(copy["sub_items"]) == 1
    assert copy["sub_items"][0]["id"] != source["sub_items"][0]["id"]
    assert copy["sub_items"][0]["completed"] is False
    assert any(
        h["action"] == "duplicated_from" and h["source_id"] == source["id"]
        for h in copy["history"]
    )
    # mutating the copy's collections must not touch the source
    copy["tags"].append("x")
    assert "x" not in source["tags"]


async def test_duplicate_lands_directly_after_source(hass: HomeAssistant, store) -> None:
    """The copy is placed immediately after its source, renumbered contiguously."""
    a = await store.async_add_task("A")
    await store.async_add_task("B")
    await store.async_add_task("C")

    copy = await store.async_duplicate_task(a["id"])

    ids = [t["id"] for t in store.tasks]  # store.tasks is sorted by sort_order
    assert ids.index(copy["id"]) == ids.index(a["id"]) + 1
    assert [t["sort_order"] for t in store.tasks] == [0, 1, 2, 3]


async def test_duplicate_heals_sort_order_ties(hass: HomeAssistant, store) -> None:
    """A pre-existing sort_order collision is healed; the copy still lands after source."""
    a = await store.async_add_task("A")
    await store.async_add_task("B")
    for t in store._data["tasks"]:  # corrupt: every task shares one sort_order
        t["sort_order"] = 5

    copy = await store.async_duplicate_task(a["id"])

    orders = [t["sort_order"] for t in store.tasks]
    assert orders == sorted(orders)
    assert len(set(orders)) == len(orders)  # contiguous + unique
    ids = [t["id"] for t in store.tasks]
    assert ids.index(copy["id"]) == ids.index(a["id"]) + 1


async def test_duplicate_copies_image_url(hass: HomeAssistant, store) -> None:
    """A valid image_url is carried over to the copy."""
    src = await store.async_add_task("Img")
    await store.async_update_task(src["id"], image_url="/local/home_tasks/x.png")
    copy = await store.async_duplicate_task(src["id"])
    assert copy["image_url"] == "/local/home_tasks/x.png"


async def test_duplicate_validates_copied_image_url(hass: HomeAssistant, store) -> None:
    """An over-length image_url on the source is rejected when duplicating."""
    src = await store.async_add_task("Img")
    # Force an over-length value directly (the update path's validator would block it).
    store._data["tasks"][0]["image_url"] = "/local/" + "x" * (MAX_IMAGE_URL_LENGTH + 10)
    with pytest.raises(ValueError):
        await store.async_duplicate_task(src["id"])


async def test_duplicate_assigned_person_override(hass: HomeAssistant, store) -> None:
    """assigned_person passed to duplicate overrides the source's assignee."""
    src = await store.async_add_task("T", assigned_person="person.alice")
    copy = await store.async_duplicate_task(src["id"], assigned_person="person.bob")
    assert copy["assigned_person"] == "person.bob"
