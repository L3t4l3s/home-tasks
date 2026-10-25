"""Fixtures shared by the integration tests."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from tests.integration.linked_list_helpers import setup_linked_list


@pytest.fixture
async def linked_list(hass: HomeAssistant, patch_add_extra_js_url):
    """A linked external list called "All Tasks" with one open task."""
    return await setup_linked_list(hass)
