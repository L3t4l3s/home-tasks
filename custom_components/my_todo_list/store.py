"""Data store for My ToDo List."""

import uuid

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_LIST_NAME, STORAGE_KEY, STORAGE_VERSION


class MyToDoListStore:
    """Manage todo list data persistence."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict | None = None

    async def async_load(self) -> None:
        """Load data from disk."""
        data = await self._store.async_load()
        if data is None:
            default_list_id = str(uuid.uuid4())
            self._data = {
                "lists": {
                    default_list_id: {
                        "id": default_list_id,
                        "name": DEFAULT_LIST_NAME,
                        "sort_order": 0,
                        "tasks": [],
                    }
                }
            }
            await self._async_save()
        else:
            self._data = data

    async def _async_save(self) -> None:
        """Save data to disk."""
        await self._store.async_save(self._data)

    # --- List methods ---

    def get_lists(self) -> list[dict]:
        """Return all lists (without tasks, for overview)."""
        result = []
        for lst in self._data["lists"].values():
            result.append({
                "id": lst["id"],
                "name": lst["name"],
                "sort_order": lst["sort_order"],
                "task_count": len(lst["tasks"]),
            })
        result.sort(key=lambda x: x["sort_order"])
        return result

    async def async_create_list(self, name: str) -> dict:
        """Create a new list."""
        list_id = str(uuid.uuid4())
        max_order = max(
            (lst["sort_order"] for lst in self._data["lists"].values()),
            default=-1,
        )
        new_list = {
            "id": list_id,
            "name": name,
            "sort_order": max_order + 1,
            "tasks": [],
        }
        self._data["lists"][list_id] = new_list
        await self._async_save()
        return {"id": list_id, "name": name, "sort_order": new_list["sort_order"], "task_count": 0}

    async def async_rename_list(self, list_id: str, name: str) -> dict:
        """Rename a list."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        lst["name"] = name
        await self._async_save()
        return {"id": list_id, "name": name}

    async def async_delete_list(self, list_id: str) -> None:
        """Delete a list."""
        if list_id not in self._data["lists"]:
            raise ValueError(f"List {list_id} not found")
        del self._data["lists"][list_id]
        await self._async_save()

    # --- Task methods ---

    def get_tasks(self, list_id: str) -> list[dict]:
        """Return all tasks for a list."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        tasks = sorted(lst["tasks"], key=lambda t: t["sort_order"])
        return tasks

    async def async_add_task(self, list_id: str, title: str) -> dict:
        """Add a task to a list."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        max_order = max(
            (t["sort_order"] for t in lst["tasks"]),
            default=-1,
        )
        task = {
            "id": str(uuid.uuid4()),
            "title": title,
            "completed": False,
            "notes": "",
            "due_date": None,
            "sort_order": max_order + 1,
            "sub_items": [],
        }
        lst["tasks"].append(task)
        await self._async_save()
        return task

    async def async_update_task(
        self, list_id: str, task_id: str, **kwargs
    ) -> dict:
        """Update a task's fields."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        for task in lst["tasks"]:
            if task["id"] == task_id:
                for key, value in kwargs.items():
                    if key in ("title", "completed", "notes", "due_date"):
                        task[key] = value
                await self._async_save()
                return task
        raise ValueError(f"Task {task_id} not found")

    async def async_delete_task(self, list_id: str, task_id: str) -> None:
        """Delete a task."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        lst["tasks"] = [t for t in lst["tasks"] if t["id"] != task_id]
        await self._async_save()

    async def async_reorder_tasks(
        self, list_id: str, task_ids: list[str]
    ) -> None:
        """Reorder tasks by providing ordered list of task IDs."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        task_map = {t["id"]: t for t in lst["tasks"]}
        for index, tid in enumerate(task_ids):
            if tid in task_map:
                task_map[tid]["sort_order"] = index
        await self._async_save()

    # --- Sub-item methods ---

    async def async_add_sub_item(
        self, list_id: str, task_id: str, title: str
    ) -> dict:
        """Add a sub-item to a task."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        for task in lst["tasks"]:
            if task["id"] == task_id:
                sub_item = {
                    "id": str(uuid.uuid4()),
                    "title": title,
                    "completed": False,
                }
                task["sub_items"].append(sub_item)
                await self._async_save()
                return sub_item
        raise ValueError(f"Task {task_id} not found")

    async def async_update_sub_item(
        self, list_id: str, task_id: str, sub_item_id: str, **kwargs
    ) -> dict:
        """Update a sub-item."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        for task in lst["tasks"]:
            if task["id"] == task_id:
                for sub in task["sub_items"]:
                    if sub["id"] == sub_item_id:
                        for key, value in kwargs.items():
                            if key in ("title", "completed"):
                                sub[key] = value
                        await self._async_save()
                        return sub
                raise ValueError(f"Sub-item {sub_item_id} not found")
        raise ValueError(f"Task {task_id} not found")

    async def async_delete_sub_item(
        self, list_id: str, task_id: str, sub_item_id: str
    ) -> None:
        """Delete a sub-item."""
        lst = self._data["lists"].get(list_id)
        if lst is None:
            raise ValueError(f"List {list_id} not found")
        for task in lst["tasks"]:
            if task["id"] == task_id:
                task["sub_items"] = [
                    s for s in task["sub_items"] if s["id"] != sub_item_id
                ]
                await self._async_save()
                return
        raise ValueError(f"Task {task_id} not found")
