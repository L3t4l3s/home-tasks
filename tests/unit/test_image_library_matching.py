"""The near-match rule of the image library (issue #56).

A wrong picture is worse than a missing one, so the rule has to be provably
narrow. These cases are the contract: what may share a picture, and what may
never.
"""
from __future__ import annotations

import pytest

from custom_components.home_tasks.image_library import is_near_match, normalize_title

pytestmark = pytest.mark.unit


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
    ("a", "b"),
    [
        # the case from the issue
        ("book a blood draw", "book a blood test"),
        ("take out the bins", "take out the bin"),
        ("water the plants", "water the plant"),
    ],
)
def test_matches(a: str, b: str) -> None:
    assert is_near_match(normalize_title(a), normalize_title(b)), f"{a!r} should match {b!r}"


@pytest.mark.parametrize(
    ("a", "b", "why"),
    [
        ("milk 1l", "milk 2l", "a number is never noise"),
        ("buy 2 apples", "buy 3 apples", "same"),
        ("zimmer aufräumen mia", "zimmer aufräumen ben", "different person, same chore"),
        ("call mum", "call mia", "two words, one of them different: too little in common"),
        ("call the plumber", "call a plumber",
         "'a' and 'the' are just words to us - a missed match costs one "
         "generation, a wrong picture costs trust"),
        ("take out the bins", "clean the windows", "unrelated"),
        ("milk", "milch", "single words are matched exactly or not at all"),
        ("water the plants", "water the plants in the greenhouse", "too many words apart"),
        ("", "anything", "empty"),
    ],
)
def test_does_not_match(a: str, b: str, why: str) -> None:
    assert not is_near_match(normalize_title(a), normalize_title(b)), why


def test_identical_titles_match() -> None:
    assert is_near_match("take out the bins", "take out the bins")
