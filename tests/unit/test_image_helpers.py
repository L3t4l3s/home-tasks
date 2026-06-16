"""Unit tests for the pure image-URL helper functions in websocket_api."""
from __future__ import annotations

import pytest

from custom_components.home_tasks.websocket_api import (
    _is_private_host,
    _local_image_name,
    _make_thumbnail,
    _MAX_THUMB_PX,
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


def test_make_thumbnail_downscales_to_webp(tmp_path) -> None:
    """A large image yields a smaller WebP thumbnail with aspect ratio kept."""
    from PIL import Image

    src = tmp_path / "pic.png"
    Image.new("RGB", (1024, 768), (200, 100, 50)).save(src)

    _make_thumbnail(str(src))

    thumb = tmp_path / "pic_thumb.webp"
    assert thumb.exists()
    with Image.open(thumb) as im:
        assert im.format == "WEBP"
        assert max(im.size) <= _MAX_THUMB_PX
        assert im.size == (512, 384)  # aspect ratio preserved
    assert thumb.stat().st_size < src.stat().st_size


def test_make_thumbnail_handles_palette_mode(tmp_path) -> None:
    """Palette/other modes are converted (no crash) and produce a thumbnail."""
    from PIL import Image

    src = tmp_path / "p.png"
    Image.new("P", (640, 640)).save(src)
    _make_thumbnail(str(src))
    assert (tmp_path / "p_thumb.webp").exists()
