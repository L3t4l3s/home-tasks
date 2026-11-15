import { HomeTasksCardEditor } from "./list-editor.js";

/**
 * The editor of the day plan card: the card title and the plan's settings.
 * A plan card has no columns, so its config is taken as it is.
 */
export class HomeTasksDayPlanCardEditor extends HomeTasksCardEditor {
  get _isPlanEditor() {
    return true;
  }

  setConfig(config) {
    // Left over from a config written when the plan was a view of the list
    // card: neither key means anything here.
    const { columns: _c, view: _v, ...rest } = config || {};
    this._config = rest;
    // Skip re-render if this setConfig is the echo of our own _fireChanged call
    if (this._ignoreNextSetConfig) {
      this._ignoreNextSetConfig = false;
      return;
    }
    if (this._listsLoaded) this._render();
  }
}
