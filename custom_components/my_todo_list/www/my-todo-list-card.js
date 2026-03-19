/**
 * My ToDo List Card for Home Assistant
 * A feature-rich todo list with drag & drop, sub-items, notes, and due dates.
 */

class MyTodoListCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._tasks = [];
    this._lists = [];
    this._filter = "all"; // all, open, done
    this._expandedTasks = new Set();
    this._editingTaskId = null;
    this._editingSubItemId = null;
    this._draggedTaskId = null;
    this._dragOverTaskId = null;
    this._newTaskTitle = "";
    this._initialized = false;
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._loadLists();
    }
  }

  // --- Data methods ---

  async _callWs(type, data = {}) {
    try {
      return await this._hass.callWS({ type, ...data });
    } catch (err) {
      console.error(`WS call ${type} failed:`, err);
      return null;
    }
  }

  async _loadLists() {
    const result = await this._callWs("my_todo_list/get_lists");
    if (result) {
      this._lists = result.lists;
      if (!this._config.list_id && this._lists.length > 0) {
        this._config = { ...this._config, list_id: this._lists[0].id };
      }
      await this._loadTasks();
    }
  }

  async _loadTasks() {
    if (!this._config.list_id) {
      this._tasks = [];
      this._render();
      return;
    }
    const result = await this._callWs("my_todo_list/get_tasks", {
      list_id: this._config.list_id,
    });
    if (result) {
      this._tasks = result.tasks;
    }
    this._render();
  }

  async _addTask() {
    const title = this._newTaskTitle.trim();
    if (!title || !this._config.list_id) return;
    await this._callWs("my_todo_list/add_task", {
      list_id: this._config.list_id,
      title,
    });
    this._newTaskTitle = "";
    await this._loadTasks();
  }

  async _toggleTask(taskId, completed) {
    await this._callWs("my_todo_list/update_task", {
      list_id: this._config.list_id,
      task_id: taskId,
      completed: !completed,
    });
    await this._loadTasks();
  }

  async _updateTaskTitle(taskId, title) {
    if (!title.trim()) return;
    await this._callWs("my_todo_list/update_task", {
      list_id: this._config.list_id,
      task_id: taskId,
      title: title.trim(),
    });
    this._editingTaskId = null;
    await this._loadTasks();
  }

  async _updateTaskNotes(taskId, notes) {
    await this._callWs("my_todo_list/update_task", {
      list_id: this._config.list_id,
      task_id: taskId,
      notes,
    });
  }

  async _updateTaskDueDate(taskId, dueDate) {
    await this._callWs("my_todo_list/update_task", {
      list_id: this._config.list_id,
      task_id: taskId,
      due_date: dueDate || null,
    });
    await this._loadTasks();
  }

  async _deleteTask(taskId) {
    await this._callWs("my_todo_list/delete_task", {
      list_id: this._config.list_id,
      task_id: taskId,
    });
    this._expandedTasks.delete(taskId);
    await this._loadTasks();
  }

  async _addSubItem(taskId) {
    await this._callWs("my_todo_list/add_sub_item", {
      list_id: this._config.list_id,
      task_id: taskId,
      title: "Neuer Unterpunkt",
    });
    await this._loadTasks();
  }

  async _toggleSubItem(taskId, subItemId, completed) {
    await this._callWs("my_todo_list/update_sub_item", {
      list_id: this._config.list_id,
      task_id: taskId,
      sub_item_id: subItemId,
      completed: !completed,
    });
    await this._loadTasks();
  }

  async _updateSubItemTitle(taskId, subItemId, title) {
    if (!title.trim()) return;
    await this._callWs("my_todo_list/update_sub_item", {
      list_id: this._config.list_id,
      task_id: taskId,
      sub_item_id: subItemId,
      title: title.trim(),
    });
    this._editingSubItemId = null;
    await this._loadTasks();
  }

  async _deleteSubItem(taskId, subItemId) {
    await this._callWs("my_todo_list/delete_sub_item", {
      list_id: this._config.list_id,
      task_id: taskId,
      sub_item_id: subItemId,
    });
    await this._loadTasks();
  }

  async _reorderTasks(taskIds) {
    await this._callWs("my_todo_list/reorder_tasks", {
      list_id: this._config.list_id,
      task_ids: taskIds,
    });
    await this._loadTasks();
  }

  // --- Filter ---

  get _filteredTasks() {
    switch (this._filter) {
      case "open":
        return this._tasks.filter((t) => !t.completed);
      case "done":
        return this._tasks.filter((t) => t.completed);
      default:
        return this._tasks;
    }
  }

  // --- Helpers ---

  _getCompletedCount() {
    return this._tasks.filter((t) => t.completed).length;
  }

  _getSubItemProgress(task) {
    if (!task.sub_items || task.sub_items.length === 0) return null;
    const done = task.sub_items.filter((s) => s.completed).length;
    return `${done}/${task.sub_items.length}`;
  }

  _isDueDateOverdue(dueDate) {
    if (!dueDate) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(dueDate) < today;
  }

  _isDueDateToday(dueDate) {
    if (!dueDate) return false;
    const today = new Date().toISOString().split("T")[0];
    return dueDate === today;
  }

  _formatDueDate(dueDate) {
    if (!dueDate) return "";
    const date = new Date(dueDate + "T00:00:00");
    return date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  _getListName() {
    if (this._config.title) return this._config.title;
    const list = this._lists.find((l) => l.id === this._config.list_id);
    return list ? list.name : "Meine Aufgaben";
  }

  // --- Render ---

  _render() {
    const completedCount = this._getCompletedCount();
    const totalCount = this._tasks.length;
    const filteredTasks = this._filteredTasks;

    this.shadowRoot.innerHTML = `
      <style>${this._getStyles()}</style>
      <ha-card>
        <div class="card-content">
          <div class="header">
            <h1 class="title">${this._getListName()}</h1>
            <span class="progress">${completedCount} von ${totalCount} erledigt</span>
          </div>

          <div class="add-task">
            <input
              type="text"
              class="add-input"
              placeholder="Neue Aufgabe hinzuf\u00fcgen..."
              value="${this._escapeHtml(this._newTaskTitle)}"
            />
            <button class="add-btn">+ Hinzuf\u00fcgen</button>
          </div>

          <div class="filters">
            <button class="filter-btn ${this._filter === "all" ? "active" : ""}" data-filter="all">Alle</button>
            <button class="filter-btn ${this._filter === "open" ? "active" : ""}" data-filter="open">Offen</button>
            <button class="filter-btn ${this._filter === "done" ? "active" : ""}" data-filter="done">Erledigt</button>
          </div>

          <div class="drag-hint">
            <span class="drag-hint-icon">\u2237</span>
            Aufgaben per Drag & Drop verschieben
          </div>

          <div class="task-list">
            ${filteredTasks.length === 0 ? '<div class="empty-state">Keine Aufgaben vorhanden</div>' : ""}
            ${filteredTasks.map((task) => this._renderTask(task)).join("")}
          </div>
        </div>
      </ha-card>
    `;

    this._attachEventListeners();
  }

  _renderTask(task) {
    const isExpanded = this._expandedTasks.has(task.id);
    const subProgress = this._getSubItemProgress(task);
    const isOverdue = this._isDueDateOverdue(task.due_date);
    const isToday = this._isDueDateToday(task.due_date);
    const isEditing = this._editingTaskId === task.id;
    const isDragOver = this._dragOverTaskId === task.id;

    return `
      <div class="task ${task.completed ? "completed" : ""} ${isDragOver ? "drag-over" : ""}"
           data-task-id="${task.id}" draggable="true">
        <div class="task-main">
          <span class="drag-handle" title="Verschieben">\u2237</span>
          <label class="checkbox-container">
            <input type="checkbox" ${task.completed ? "checked" : ""} data-toggle-task="${task.id}" />
            <span class="checkmark"></span>
          </label>
          ${
            isEditing
              ? `<input type="text" class="edit-title-input" data-edit-task="${task.id}" value="${this._escapeHtml(task.title)}" />`
              : `<span class="task-title" data-start-edit="${task.id}">${this._escapeHtml(task.title)}</span>`
          }
          <div class="task-meta">
            ${subProgress ? `<span class="sub-badge">${subProgress}</span>` : ""}
            ${
              task.due_date
                ? `<span class="due-date ${isOverdue ? "overdue" : ""} ${isToday ? "today" : ""}">${this._formatDueDate(task.due_date)}</span>`
                : ""
            }
          </div>
          <button class="expand-btn" data-expand="${task.id}">
            ${isExpanded ? "\u25BC" : "\u25B6"}
          </button>
        </div>
        ${isExpanded ? this._renderTaskDetails(task) : ""}
      </div>
    `;
  }

  _renderTaskDetails(task) {
    return `
      <div class="task-details">
        <div class="detail-section">
          <label class="detail-label">F\u00e4lligkeitsdatum</label>
          <input type="date" class="date-input" data-due-date="${task.id}"
                 value="${task.due_date || ""}" />
        </div>

        <div class="detail-section">
          <label class="detail-label">Notizen</label>
          <textarea class="notes-input" data-notes="${task.id}"
                    placeholder="Hier kannst du Notizen hinzuf\u00fcgen"
                    rows="2">${this._escapeHtml(task.notes || "")}</textarea>
        </div>

        <div class="detail-section">
          <label class="detail-label">Unterpunkte</label>
          ${task.sub_items
            .map(
              (sub) => `
            <div class="sub-item">
              <label class="checkbox-container small">
                <input type="checkbox" ${sub.completed ? "checked" : ""}
                       data-toggle-sub="${task.id}:${sub.id}" />
                <span class="checkmark"></span>
              </label>
              ${
                this._editingSubItemId === sub.id
                  ? `<input type="text" class="edit-sub-input" data-edit-sub="${task.id}:${sub.id}" value="${this._escapeHtml(sub.title)}" />`
                  : `<span class="sub-title ${sub.completed ? "completed" : ""}" data-start-edit-sub="${sub.id}">${this._escapeHtml(sub.title)}</span>`
              }
              <button class="delete-sub-btn" data-delete-sub="${task.id}:${sub.id}" title="L\u00f6schen">\u00D7</button>
            </div>
          `
            )
            .join("")}
          <button class="add-sub-btn" data-add-sub="${task.id}">+ Unterpunkt hinzuf\u00fcgen</button>
        </div>

        <div class="detail-actions">
          <button class="delete-task-btn" data-delete-task="${task.id}">Aufgabe l\u00f6schen</button>
        </div>
      </div>
    `;
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Event Listeners ---

  _attachEventListeners() {
    const root = this.shadowRoot;

    // Add task
    const addInput = root.querySelector(".add-input");
    const addBtn = root.querySelector(".add-btn");
    if (addInput) {
      addInput.addEventListener("input", (e) => {
        this._newTaskTitle = e.target.value;
      });
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this._addTask();
      });
    }
    if (addBtn) {
      addBtn.addEventListener("click", () => this._addTask());
    }

    // Filter buttons
    root.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._filter = btn.dataset.filter;
        this._render();
      });
    });

    // Toggle task
    root.querySelectorAll("[data-toggle-task]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const task = this._tasks.find((t) => t.id === cb.dataset.toggleTask);
        if (task) this._toggleTask(task.id, task.completed);
      });
    });

    // Expand/collapse
    root.querySelectorAll("[data-expand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const taskId = btn.dataset.expand;
        if (this._expandedTasks.has(taskId)) {
          this._expandedTasks.delete(taskId);
        } else {
          this._expandedTasks.add(taskId);
        }
        this._render();
      });
    });

    // Start editing task title
    root.querySelectorAll("[data-start-edit]").forEach((el) => {
      el.addEventListener("dblclick", () => {
        this._editingTaskId = el.dataset.startEdit;
        this._render();
        const input = root.querySelector(`[data-edit-task="${this._editingTaskId}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    });

    // Edit task title
    root.querySelectorAll("[data-edit-task]").forEach((input) => {
      const taskId = input.dataset.editTask;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this._updateTaskTitle(taskId, input.value);
        } else if (e.key === "Escape") {
          this._editingTaskId = null;
          this._render();
        }
      });
      input.addEventListener("blur", () => {
        this._updateTaskTitle(taskId, input.value);
      });
    });

    // Due date
    root.querySelectorAll("[data-due-date]").forEach((input) => {
      input.addEventListener("change", () => {
        this._updateTaskDueDate(input.dataset.dueDate, input.value);
      });
    });

    // Notes
    root.querySelectorAll("[data-notes]").forEach((textarea) => {
      let debounceTimer;
      textarea.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this._updateTaskNotes(textarea.dataset.notes, textarea.value);
        }, 500);
      });
    });

    // Sub-item toggle
    root.querySelectorAll("[data-toggle-sub]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const [taskId, subId] = cb.dataset.toggleSub.split(":");
        const task = this._tasks.find((t) => t.id === taskId);
        const sub = task?.sub_items.find((s) => s.id === subId);
        if (sub) this._toggleSubItem(taskId, subId, sub.completed);
      });
    });

    // Start editing sub-item
    root.querySelectorAll("[data-start-edit-sub]").forEach((el) => {
      el.addEventListener("dblclick", () => {
        this._editingSubItemId = el.dataset.startEditSub;
        this._render();
        const input = root.querySelector(`[data-edit-sub*="${this._editingSubItemId}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    });

    // Edit sub-item title
    root.querySelectorAll("[data-edit-sub]").forEach((input) => {
      const [taskId, subId] = input.dataset.editSub.split(":");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this._updateSubItemTitle(taskId, subId, input.value);
        } else if (e.key === "Escape") {
          this._editingSubItemId = null;
          this._render();
        }
      });
      input.addEventListener("blur", () => {
        this._updateSubItemTitle(taskId, subId, input.value);
      });
    });

    // Add sub-item
    root.querySelectorAll("[data-add-sub]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._addSubItem(btn.dataset.addSub);
      });
    });

    // Delete sub-item
    root.querySelectorAll("[data-delete-sub]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [taskId, subId] = btn.dataset.deleteSub.split(":");
        this._deleteSubItem(taskId, subId);
      });
    });

    // Delete task
    root.querySelectorAll("[data-delete-task]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._deleteTask(btn.dataset.deleteTask);
      });
    });

    // Drag & drop
    this._attachDragListeners();
  }

  _attachDragListeners() {
    const root = this.shadowRoot;
    const tasks = root.querySelectorAll(".task[draggable]");

    tasks.forEach((taskEl) => {
      const taskId = taskEl.dataset.taskId;

      taskEl.addEventListener("dragstart", (e) => {
        this._draggedTaskId = taskId;
        e.dataTransfer.effectAllowed = "move";
        taskEl.classList.add("dragging");
        // Need a small delay for the class to apply before drag image is captured
        setTimeout(() => taskEl.classList.add("dragging"), 0);
      });

      taskEl.addEventListener("dragend", () => {
        this._draggedTaskId = null;
        this._dragOverTaskId = null;
        root.querySelectorAll(".task").forEach((el) => {
          el.classList.remove("dragging", "drag-over");
        });
      });

      taskEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (this._draggedTaskId && this._draggedTaskId !== taskId) {
          this._dragOverTaskId = taskId;
          root.querySelectorAll(".task").forEach((el) => el.classList.remove("drag-over"));
          taskEl.classList.add("drag-over");
        }
      });

      taskEl.addEventListener("dragleave", () => {
        taskEl.classList.remove("drag-over");
      });

      taskEl.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!this._draggedTaskId || this._draggedTaskId === taskId) return;

        // Reorder
        const currentOrder = this._filteredTasks.map((t) => t.id);
        const fromIndex = currentOrder.indexOf(this._draggedTaskId);
        const toIndex = currentOrder.indexOf(taskId);
        if (fromIndex === -1 || toIndex === -1) return;

        // Build new full order from all tasks
        const allIds = this._tasks.map((t) => t.id);
        const draggedId = this._draggedTaskId;
        const newAllIds = allIds.filter((id) => id !== draggedId);
        const targetFullIndex = newAllIds.indexOf(taskId);
        newAllIds.splice(
          fromIndex < toIndex ? targetFullIndex + 1 : targetFullIndex,
          0,
          draggedId
        );

        this._draggedTaskId = null;
        this._dragOverTaskId = null;
        this._reorderTasks(newAllIds);
      });
    });
  }

  // --- Styles ---

  _getStyles() {
    return `
      :host {
        --todo-primary: var(--primary-color, #03a9f4);
        --todo-bg: var(--card-background-color, #fff);
        --todo-text: var(--primary-text-color, #212121);
        --todo-secondary-text: var(--secondary-text-color, #727272);
        --todo-divider: var(--divider-color, #e0e0e0);
        --todo-surface: var(--secondary-background-color, #f5f5f5);
        --todo-disabled: var(--disabled-text-color, #bdbdbd);
        --todo-error: var(--error-color, #db4437);
        --todo-success: var(--success-color, #43a047);
        --todo-radius: 8px;
      }

      ha-card {
        overflow: hidden;
      }

      .card-content {
        padding: 16px;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 16px;
      }

      .title {
        font-size: 24px;
        font-weight: 700;
        color: var(--todo-text);
        margin: 0;
      }

      .progress {
        font-size: 14px;
        color: var(--todo-secondary-text);
      }

      /* --- Add Task --- */
      .add-task {
        display: flex;
        gap: 8px;
        margin-bottom: 16px;
      }

      .add-input {
        flex: 1;
        padding: 10px 14px;
        border: 1px solid var(--todo-divider);
        border-radius: var(--todo-radius);
        background: var(--todo-bg);
        color: var(--todo-text);
        font-size: 14px;
        outline: none;
        font-family: inherit;
      }

      .add-input:focus {
        border-color: var(--todo-primary);
      }

      .add-input::placeholder {
        color: var(--todo-disabled);
      }

      .add-btn {
        padding: 10px 20px;
        background: var(--todo-primary);
        color: #fff;
        border: none;
        border-radius: var(--todo-radius);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        font-family: inherit;
      }

      .add-btn:hover {
        opacity: 0.9;
      }

      /* --- Filters --- */
      .filters {
        display: flex;
        gap: 4px;
        margin-bottom: 12px;
      }

      .filter-btn {
        padding: 6px 16px;
        border: none;
        border-radius: 20px;
        background: transparent;
        color: var(--todo-secondary-text);
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.2s;
      }

      .filter-btn.active {
        background: var(--todo-primary);
        color: #fff;
      }

      .filter-btn:not(.active):hover {
        background: var(--todo-surface);
      }

      /* --- Drag hint --- */
      .drag-hint {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--todo-disabled);
        margin-bottom: 8px;
        padding: 4px 0;
      }

      .drag-hint-icon {
        font-size: 14px;
      }

      /* --- Task list --- */
      .task-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .empty-state {
        text-align: center;
        padding: 24px;
        color: var(--todo-disabled);
        font-size: 14px;
      }

      .task {
        border: 1px solid var(--todo-divider);
        border-radius: var(--todo-radius);
        background: var(--todo-bg);
        transition: box-shadow 0.2s, border-color 0.2s;
      }

      .task.dragging {
        opacity: 0.5;
      }

      .task.drag-over {
        border-color: var(--todo-primary);
        box-shadow: 0 0 0 1px var(--todo-primary);
      }

      .task-main {
        display: flex;
        align-items: center;
        padding: 10px 12px;
        gap: 8px;
        min-height: 44px;
      }

      .drag-handle {
        cursor: grab;
        color: var(--todo-disabled);
        font-size: 16px;
        user-select: none;
        padding: 4px 2px;
        line-height: 1;
      }

      .drag-handle:active {
        cursor: grabbing;
      }

      /* --- Checkbox --- */
      .checkbox-container {
        position: relative;
        display: inline-flex;
        align-items: center;
        cursor: pointer;
        flex-shrink: 0;
      }

      .checkbox-container input {
        position: absolute;
        opacity: 0;
        cursor: pointer;
        height: 0;
        width: 0;
      }

      .checkmark {
        height: 20px;
        width: 20px;
        border: 2px solid var(--todo-divider);
        border-radius: 4px;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .checkbox-container:hover .checkmark {
        border-color: var(--todo-primary);
      }

      .checkbox-container input:checked ~ .checkmark {
        background: var(--todo-primary);
        border-color: var(--todo-primary);
      }

      .checkbox-container input:checked ~ .checkmark::after {
        content: "";
        display: block;
        width: 5px;
        height: 9px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
        margin-top: -1px;
      }

      .checkbox-container.small .checkmark {
        height: 16px;
        width: 16px;
      }

      .checkbox-container.small input:checked ~ .checkmark::after {
        width: 4px;
        height: 7px;
      }

      /* --- Task title --- */
      .task-title {
        flex: 1;
        font-size: 14px;
        color: var(--todo-text);
        cursor: default;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .task.completed .task-title {
        text-decoration: line-through;
        color: var(--todo-disabled);
      }

      .edit-title-input,
      .edit-sub-input {
        flex: 1;
        padding: 4px 8px;
        border: 1px solid var(--todo-primary);
        border-radius: 4px;
        font-size: 14px;
        background: var(--todo-bg);
        color: var(--todo-text);
        outline: none;
        font-family: inherit;
        min-width: 0;
      }

      /* --- Task meta --- */
      .task-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }

      .sub-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--todo-surface);
        color: var(--todo-secondary-text);
        font-weight: 500;
      }

      .due-date {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--todo-surface);
        color: var(--todo-secondary-text);
      }

      .due-date.today {
        background: #fff3e0;
        color: #e65100;
      }

      .due-date.overdue {
        background: #ffebee;
        color: var(--todo-error);
        font-weight: 500;
      }

      .expand-btn {
        background: none;
        border: none;
        color: var(--todo-secondary-text);
        cursor: pointer;
        font-size: 10px;
        padding: 6px;
        border-radius: 4px;
        line-height: 1;
        flex-shrink: 0;
      }

      .expand-btn:hover {
        background: var(--todo-surface);
      }

      /* --- Task details --- */
      .task-details {
        padding: 8px 12px 12px 44px;
        border-top: 1px solid var(--todo-divider);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .detail-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .detail-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--todo-secondary-text);
        letter-spacing: 0.5px;
      }

      .date-input {
        padding: 6px 10px;
        border: 1px solid var(--todo-divider);
        border-radius: 4px;
        font-size: 13px;
        background: var(--todo-bg);
        color: var(--todo-text);
        font-family: inherit;
        max-width: 180px;
      }

      .notes-input {
        padding: 8px 10px;
        border: 1px solid var(--todo-divider);
        border-radius: 4px;
        font-size: 13px;
        background: var(--todo-surface);
        color: var(--todo-text);
        resize: vertical;
        min-height: 40px;
        font-family: inherit;
        outline: none;
      }

      .notes-input:focus {
        border-color: var(--todo-primary);
        background: var(--todo-bg);
      }

      /* --- Sub items --- */
      .sub-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
      }

      .sub-title {
        flex: 1;
        font-size: 13px;
        color: var(--todo-text);
        cursor: default;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .sub-title.completed {
        text-decoration: line-through;
        color: var(--todo-disabled);
      }

      .delete-sub-btn {
        background: none;
        border: none;
        color: var(--todo-disabled);
        cursor: pointer;
        font-size: 16px;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
        flex-shrink: 0;
      }

      .delete-sub-btn:hover {
        color: var(--todo-error);
        background: #ffebee;
      }

      .add-sub-btn {
        background: none;
        border: none;
        color: var(--todo-primary);
        cursor: pointer;
        font-size: 13px;
        padding: 6px 0;
        text-align: left;
        font-family: inherit;
      }

      .add-sub-btn:hover {
        text-decoration: underline;
      }

      /* --- Delete task --- */
      .detail-actions {
        display: flex;
        justify-content: flex-end;
        padding-top: 4px;
      }

      .delete-task-btn {
        background: none;
        border: 1px solid var(--todo-error);
        color: var(--todo-error);
        padding: 6px 14px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }

      .delete-task-btn:hover {
        background: #ffebee;
      }
    `;
  }

  // --- Card config ---

  static getConfigElement() {
    return document.createElement("my-todo-list-card-editor");
  }

  static getStubConfig() {
    return { title: "" };
  }

  getCardSize() {
    return 3 + this._tasks.length;
  }
}

/**
 * Card Editor
 */
class MyTodoListCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._lists = [];
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadLists();
  }

  async _loadLists() {
    try {
      const result = await this._hass.callWS({ type: "my_todo_list/get_lists" });
      if (result) {
        this._lists = result.lists;
        this._render();
      }
    } catch (e) {
      // Integration might not be loaded yet
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .editor {
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 16px 0;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        label {
          font-size: 12px;
          font-weight: 500;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        select, input {
          padding: 8px 12px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          font-size: 14px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-family: inherit;
        }
        .create-list {
          display: flex;
          gap: 8px;
        }
        .create-list input {
          flex: 1;
        }
        button {
          padding: 8px 16px;
          background: var(--primary-color);
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          font-family: inherit;
        }
        button:hover {
          opacity: 0.9;
        }
      </style>
      <div class="editor">
        <div class="field">
          <label>Liste</label>
          <select id="list-select">
            ${this._lists.map((l) => `<option value="${l.id}" ${l.id === this._config.list_id ? "selected" : ""}>${l.name}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Neue Liste erstellen</label>
          <div class="create-list">
            <input type="text" id="new-list-name" placeholder="Listenname..." />
            <button id="create-list-btn">Erstellen</button>
          </div>
        </div>
        <div class="field">
          <label>Titel (optional)</label>
          <input type="text" id="title-input" value="${this._config.title || ""}"
                 placeholder="Standard: Listenname" />
        </div>
      </div>
    `;

    // Events
    const listSelect = this.shadowRoot.getElementById("list-select");
    listSelect?.addEventListener("change", () => {
      this._config = { ...this._config, list_id: listSelect.value };
      this._fireChanged();
    });

    const titleInput = this.shadowRoot.getElementById("title-input");
    titleInput?.addEventListener("input", () => {
      this._config = { ...this._config, title: titleInput.value };
      this._fireChanged();
    });

    const createBtn = this.shadowRoot.getElementById("create-list-btn");
    createBtn?.addEventListener("click", async () => {
      const nameInput = this.shadowRoot.getElementById("new-list-name");
      const name = nameInput?.value?.trim();
      if (!name) return;
      try {
        const result = await this._hass.callWS({
          type: "my_todo_list/create_list",
          name,
        });
        if (result) {
          this._config = { ...this._config, list_id: result.id };
          this._fireChanged();
          nameInput.value = "";
          await this._loadLists();
        }
      } catch (e) {
        console.error("Failed to create list:", e);
      }
    });
  }

  _fireChanged() {
    const event = new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

customElements.define("my-todo-list-card", MyTodoListCard);
customElements.define("my-todo-list-card-editor", MyTodoListCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "my-todo-list-card",
  name: "My ToDo List",
  description: "A feature-rich todo list with drag & drop, sub-items, notes, and due dates.",
});
