"""Tests for the View Assist assets in docs/view-assist/ (issue #18).

These files are shipped as copy-and-install assets, not as code, so nothing
imports them at runtime — this module is the only thing that keeps them
honest. It checks that

* the view YAMLs parse and survive View Assist's install/backup round trip,
* every card option they use actually exists (documented in the README),
* the blueprint is a valid blueprint AND substitutes into a valid automation,
* the `config_entry_id(todo_entity)` trick the blueprint uses to find a
  list's `list_id` really returns the config entry id the card expects.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.template import Template
from homeassistant.util.yaml import load_yaml_dict, parse_yaml, save_yaml

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
REPO_ROOT = Path(__file__).resolve().parents[2]
VA_DIR = REPO_ROOT / "docs" / "view-assist"
STATIC_VIEW = VA_DIR / "hometasks.yaml"
DYNAMIC_VIEW = VA_DIR / "hometasks-dynamic.yaml"
BLUEPRINT = VA_DIR / "blueprint-hometasks.yaml"

# The view name the docs install these under; View Assist derives the version
# key and the dashboard path from it.
VIEW_NAME = "hometasks"


def _load(path: Path) -> dict:
    return load_yaml_dict(str(path))


def _blueprint():
    """Load the blueprint the way HA loads one from blueprints/automation/."""
    from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA
    from homeassistant.components.blueprint import models

    return models.Blueprint(
        parse_yaml(BLUEPRINT.read_text(encoding="utf-8")),
        expected_domain="automation",
        path=str(BLUEPRINT),
        schema=AUTOMATION_BLUEPRINT_SCHEMA,
    )


def _documented_card_options() -> set[str]:
    """Collect every card option name from the README option tables.

    The tables list options as `| `option` | default | description |`; the
    badge row lists several slash-separated names in one cell.
    """
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    names: set[str] = set()
    for line in readme.splitlines():
        if not line.startswith("| `"):
            continue
        cell = line.split("|")[1]
        names.update(re.findall(r"`([a-z_][a-z0-9_.]*)`", cell))
    # Dotted card-level keys are documented as `image_generation.entity_id`
    names.update({n.split(".")[0] for n in names if "." in n})
    return names


# ---------------------------------------------------------------------------
# View YAMLs
# ---------------------------------------------------------------------------


def test_views_exist() -> None:
    """Both shipped views and the blueprint are present."""
    assert STATIC_VIEW.is_file()
    assert DYNAMIC_VIEW.is_file()
    assert BLUEPRINT.is_file()


def test_static_view_is_a_home_tasks_card() -> None:
    """The simple view is the card itself — no extra frontend dependency."""
    cfg = _load(STATIC_VIEW)
    assert cfg["type"] == "custom:home-tasks-card"
    assert isinstance(cfg["columns"], list) and len(cfg["columns"]) == 1


def test_static_view_has_no_list_id_so_it_works_unconfigured() -> None:
    """No list_id means the card falls back to the first Home Tasks list.

    A placeholder value would instead make the card retry the (failing) list
    lookup for five minutes, so the file must ship without one.
    """
    col = _load(STATIC_VIEW)["columns"][0]
    assert "list_id" not in col
    assert "entity_id" not in col


def test_dynamic_view_wraps_the_card_in_button_card() -> None:
    """The per-satellite view keeps View Assist's own chrome."""
    cfg = _load(DYNAMIC_VIEW)
    assert cfg["type"] == "custom:button-card"
    # Same templates the built-in View Assist views use.
    assert cfg["template"] == ["variable_template", "body_template"]
    card = cfg["custom_fields"]["message"]["card"]
    assert card["type"] == "custom:home-tasks-card"


def test_dynamic_view_reads_the_satellite_attribute() -> None:
    """list_id comes from the satellite's `home_tasks_list` attribute.

    button-card evaluates `[[[ … ]]]` recursively through objects and lists,
    so the template inside columns[0] is evaluated — the variable it reads
    must therefore be defined on the card, and must swallow a missing
    attribute (the card then falls back to the first list).
    """
    cfg = _load(DYNAMIC_VIEW)
    var = cfg["variables"]["var_ht_list_id"]
    assert "home_tasks_list" in var
    assert "var_assistsat_entity" in var  # provided by variable_template
    assert "catch" in var  # missing satellite/attribute must not throw
    tpl = cfg["custom_fields"]["message"]["card"]["columns"][0]["list_id"]
    assert tpl.strip().startswith("[[[") and tpl.strip().endswith("]]]")
    assert "var_ht_list_id" in tpl


@pytest.mark.parametrize("path", [STATIC_VIEW, DYNAMIC_VIEW])
def test_view_only_uses_documented_card_options(path: Path) -> None:
    """Every column/card option in a view exists in the README reference."""
    documented = _documented_card_options()
    cfg = _load(path)
    card = (
        cfg
        if cfg["type"] == "custom:home-tasks-card"
        else cfg["custom_fields"]["message"]["card"]
    )
    unknown_root = set(card) - documented - {"type", "variables", "card_mod"}
    assert not unknown_root, f"undocumented card options in {path.name}: {unknown_root}"
    for col in card["columns"]:
        unknown = set(col) - documented
        assert not unknown, f"undocumented column options in {path.name}: {unknown}"


@pytest.mark.parametrize("path", [STATIC_VIEW, DYNAMIC_VIEW])
def test_view_carries_a_version_marker(path: Path) -> None:
    """View Assist reads `variables.<viewname>version` when it installs."""
    cfg = _load(path)
    variables = cfg.get("variables") or {}
    # Mirrors ViewManager._read_view_version()
    version = variables.get(f"{VIEW_NAME}version", variables.get(f"{VIEW_NAME}cardversion", "0.0.0"))
    assert re.fullmatch(r"\d+\.\d+\.\d+", str(version)), path.name


@pytest.mark.parametrize("path", [STATIC_VIEW, DYNAMIC_VIEW])
def test_view_survives_view_assist_install_and_backup(path: Path, tmp_path: Path) -> None:
    """Replicates what View Assist does with the file.

    Install wraps the card config into a panel view and stores it in the
    Lovelace dashboard config (which is JSON-serialised); `save_asset` writes
    the card back out with save_yaml. Both must round-trip unchanged.
    """
    cfg = _load(path)

    new_view = {
        "type": "panel",
        "title": VIEW_NAME.title(),
        "path": VIEW_NAME,
        "cards": [cfg],
    }
    # Lovelace storage is JSON — anything not JSON-safe would be lost.
    restored = json.loads(json.dumps(new_view))
    assert restored == new_view

    backup = tmp_path / f"{VIEW_NAME}.saved.yaml"
    save_yaml(str(backup), restored["cards"][0])
    assert load_yaml_dict(str(backup)) == cfg


# ---------------------------------------------------------------------------
# Blueprint
# ---------------------------------------------------------------------------


def test_blueprint_is_valid_and_declares_its_inputs() -> None:
    """The file is a valid HA automation blueprint."""
    blueprint = _blueprint()

    assert blueprint.domain == "automation"
    # Blueprint() itself rejects a body that uses an undeclared !input; make
    # the reverse explicit too, so unused inputs do not pile up.
    from homeassistant.util import yaml as yaml_util

    used = yaml_util.extract_inputs(blueprint.data)
    assert set(blueprint.inputs) == used


def test_blueprint_targets_home_tasks_todo_entities() -> None:
    """The list selector only offers Home Tasks lists."""
    blueprint = parse_yaml(BLUEPRINT.read_text(encoding="utf-8"))
    selector = blueprint["blueprint"]["input"]["todo_entity"]["selector"]["entity"]
    assert selector["filter"] == [{"integration": DOMAIN, "domain": "todo"}]


async def test_blueprint_substitutes_into_a_valid_automation(hass: HomeAssistant) -> None:
    """Filling the blueprint in produces a config HA accepts as an automation."""
    from homeassistant.components.automation.config import async_validate_config_item
    from homeassistant.components.blueprint import models
    from homeassistant.setup import async_setup_component

    assert await async_setup_component(hass, "automation", {})

    inputs = models.BlueprintInputs(
        _blueprint(),
        {
            "use_blueprint": {
                "path": BLUEPRINT.name,
                "input": {"todo_entity": "todo.test_list"},
            },
            "alias": "VA Home Tasks",
        },
    )
    config = inputs.async_substitute()
    # Defaults must cover every input the user did not fill in.
    assert "!input" not in json.dumps(config, default=str)

    validated = await async_validate_config_item(hass, "automation", config)
    assert validated is not None


async def test_blueprint_speaks_before_it_navigates() -> None:
    """The spoken answer is set for both display and audio-only satellites."""
    blueprint = parse_yaml(BLUEPRINT.read_text(encoding="utf-8"))
    actions = blueprint["actions"]
    kinds = [next(iter(step)) for step in actions]
    assert "set_conversation_response" in kinds
    # navigate/set_state for the view are behind the audio_only guard
    guarded = actions[kinds.index("if")]["then"]
    services = [step["action"] for step in guarded]
    assert services == ["view_assist.set_state", "view_assist.navigate"]
    state_data = guarded[0]["data"]
    assert "home_tasks_list" in state_data  # read by hometasks-dynamic.yaml
    assert "list" in state_data  # keeps View Assist's own list view working


def test_blueprint_default_view_path_matches_the_view_name() -> None:
    """The blueprint navigates to the path the view installs under."""
    blueprint = parse_yaml(BLUEPRINT.read_text(encoding="utf-8"))
    default = blueprint["blueprint"]["input"]["view"]["default"]
    assert default == f"/view-assist/{VIEW_NAME}"


# ---------------------------------------------------------------------------
# The list_id lookup the blueprint relies on
# ---------------------------------------------------------------------------


async def test_config_entry_id_of_todo_entity_is_the_cards_list_id(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """`config_entry_id(todo.x)` == the `list_id` the card wants.

    This is the whole reason the blueprint can take a friendly todo entity
    instead of asking the user for an opaque config entry id.
    """
    entity_id = er.async_get(hass).async_get_entity_id(
        "todo", DOMAIN, mock_config_entry.entry_id
    )
    assert entity_id is not None

    rendered = Template(
        "{{ config_entry_id('" + entity_id + "') }}", hass
    ).async_render(parse_result=False)

    assert rendered == mock_config_entry.entry_id
