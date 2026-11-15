import { HomeTasksCard } from "./list-card.js";

/**
 * The days of a day plan: a card type of its own in the picker and in YAML
 * (custom:home-tasks-day-plan-card). It is the list card in its plan mode -
 * a row is a task of a list, and everything a row does is the list's code.
 */
export class HomeTasksDayPlanCard extends HomeTasksCard {
  setConfig(config) {
    this._setPlanConfig(config || {});
  }

  static getConfigElement() {
    return document.createElement("home-tasks-day-plan-card-editor");
  }

  // What the picker starts a new card with: the first plan there is. With
  // several plans a card has to name one, so it is named from the start.
  static async getStubConfig(hass) {
    const config = { days: 3 };
    try {
      const result = await hass.callWS({ type: "home_tasks/get_plans" });
      const first = result && Array.isArray(result.plans) && result.plans[0];
      if (first) config.plan = first.id;
    } catch (_) { /* no plan yet, or not reachable: the card says so */ }
    return config;
  }
}
