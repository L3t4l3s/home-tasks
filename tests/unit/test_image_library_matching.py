"""The near-match rule of the image library (issue #56).

A wrong picture is worse than a missing one, so the rule is narrow on
purpose: every word of a title has to be there, and a word only counts as
present if it is the same word. An inflected ending may differ, nothing else.
These cases are the contract.
"""
from __future__ import annotations

import pytest

from custom_components.home_tasks.image_library import is_near_match, normalize_title

pytestmark = pytest.mark.unit


def match(a: str, b: str) -> bool:
    return is_near_match(normalize_title(a), normalize_title(b))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Take out the BINS  ", "take out the bins"),
        ("Zimmer aufräumen!", "zimmer aufräumen"),
        ("Buy milk, bread & eggs", "buy milk bread eggs"),
        ("Milch   kaufen", "milch kaufen"),
        ("", ""),
    ],
)
def test_normalisation(raw: str, expected: str) -> None:
    assert normalize_title(raw) == expected


@pytest.mark.parametrize(
    ("a", "b", "why"),
    [
        ("Take out the bins", "take out the bins", "same title, different case"),
        ("Zimmer aufräumen", "  zimmer   aufräumen!  ", "punctuation and spacing"),
        ("Take out the bins", "Take out the bin", "singular and plural"),
        ("Water the plants", "Water the plant", "same"),
        ("Zimmer aufräumen", "aufräumen Zimmer", "same words, other order"),
    ],
)
def test_matches(a: str, b: str, why: str) -> None:
    assert match(a, b), why


@pytest.mark.parametrize(
    ("a", "b", "why"),
    [
        # A different word is a different task. Nothing in a title says which
        # word carries the meaning, so none of them may differ.
        ("Bens Zimmer aufräumen", "Bens Zimmer saugen", "different verb"),
        ("Bens Zimmer aufräumen", "Bens Zimmer putzen", "different verb"),
        ("Kevins Wand streichen", "Kevins Decke streichen", "different object"),
        ("Zimmer aufräumen Mia", "Zimmer aufräumen Ben", "different child"),
        ("Zimmer aufräumen für Mia", "Zimmer aufräumen für Ben", "same, longer title"),
        ("book a blood draw", "book a blood test", "different word, however similar"),
        ("Bens Zimmer saugen", "Bens Zimmer sagen", "similar spelling, unrelated meaning"),
        ("milk 1l", "milk 2l", "a quantity is a word too"),
        ("buy 2 apples", "buy 3 apples", "same"),
        ("milk", "milch", "not an ending, a different word"),
        ("water the plants", "water the plants in the greenhouse", "extra words"),
        ("", "anything", "empty"),
    ],
)
def test_does_not_match(a: str, b: str, why: str) -> None:
    assert not match(a, b), why
