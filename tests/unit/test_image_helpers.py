"""Unit tests for the pure image-URL helper functions in websocket_api."""
from __future__ import annotations

import pytest

from custom_components.home_tasks.websocket_api import (
    _is_private_host,
    _local_image_name,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "url,expected",
    [
        ("/local/home_tasks/abc.png", "abc.png"),
        ("/local/home_tasks/abc.png?v=123", "abc.png"),
        ("/local/home_tasks/sub.dir.png", "sub.dir.png"),
        ("/media/local/home_tasks/abc.png", None),
        ("/ai_task/image/x.png?authSig=z", None),
        ("https://cdn.example.com/local/home_tasks/x.png", None),
        ("media-source://media_source/x.png", None),
        ("", None),
        (None, None),
    ],
)
def test_local_image_name(url, expected) -> None:
    """Only our public /local/home_tasks/ paths map to a bare filename."""
    assert _local_image_name(url) == expected


@pytest.mark.parametrize(
    "host,expected",
    [
        ("127.0.0.1", True),
        ("192.168.1.10", True),
        ("10.0.0.5", True),
        ("172.16.0.1", True),
        ("::1", True),
        ("8.8.8.8", False),
        ("1.2.3.4", False),
        ("homeassistant.local", False),
        ("example.com", False),
        ("", False),
        (None, False),
    ],
)
def test_is_private_host(host, expected) -> None:
    """Private/loopback IPs are internal; public IPs and named hosts are not."""
    assert _is_private_host(host) is expected
