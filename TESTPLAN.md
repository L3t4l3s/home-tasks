# Testplan: Events, Sensoren & Services

## Vorbereitung

1. HACS → My ToDo List aktualisieren
2. HA neu starten
3. Mindestens eine Liste anlegen (z.B. "Einkaufsliste")
4. Mindestens eine Person in HA eingerichtet haben (z.B. `person.max`)

---

## 1. Events testen

### 1.1 Event-Listener einrichten

In **Entwicklerwerkzeuge → Ereignisse → Ereignisse abonnieren** jeweils eintragen und auf "Starte zuhören" klicken:

```
my_todo_list_task_created
```

```
my_todo_list_task_completed
```

```
my_todo_list_task_due
```

```
my_todo_list_task_overdue
```

```
my_todo_list_task_assigned
```

```
my_todo_list_task_reopened
```

### 1.2 task_created testen

**Aktion:** Neue Aufgabe in der Card erstellen (z.B. "Testaufgabe")

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_created",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe"
  }
}
```

### 1.3 task_completed testen

**Aktion:** Die Testaufgabe abhaken

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_completed",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe"
  }
}
```

### 1.4 task_assigned testen

**Aktion:** Aufgabe aufklappen → Person zuweisen

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_assigned",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe",
    "assigned_person": "person.max",
    "previous_person": null
  }
}
```

### 1.5 task_due testen

**Aktion:** Aufgabe aufklappen → Fälligkeitsdatum auf HEUTE setzen → bis zu 1h warten (oder HA neu starten, da der Check auch beim Start läuft)

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_due",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe",
    "due_date": "2026-03-23"
  }
}
```

### 1.6 task_overdue testen

**Aktion:** Fälligkeitsdatum auf GESTERN setzen → HA neu starten (oder 1h warten)

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_overdue",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe",
    "due_date": "2026-03-22"
  }
}
```

### 1.7 task_reopened testen

**Aktion:** Aufgabe mit Wiederholung einrichten (z.B. alle 1 Stunden), als erledigt markieren, warten

**Erwartetes Event:**
```json
{
  "event_type": "my_todo_list_task_reopened",
  "data": {
    "entry_id": "...",
    "task_id": "...",
    "task_title": "Testaufgabe"
  }
}
```

---

## 2. Sensoren testen

### 2.1 Open Tasks Sensor prüfen

**Wo:** Entwicklerwerkzeuge → Zustände → Suche nach `sensor.*offene_aufgaben`

**Tests:**
1. Erstelle 3 Aufgaben → Sensor-Wert sollte `3` sein
2. Hake 1 ab → Sensor-Wert sollte `2` sein
3. Lösche 1 → Sensor-Wert sollte `1` sein

**Attribute prüfen (auf den Sensor klicken):**
```yaml
open_task_titles:
  - "Aufgabe 1"
  - "Aufgabe 3"
overdue_count: 0
total_tasks: 3
```

### 2.2 Overdue Binary Sensor prüfen

**Wo:** Entwicklerwerkzeuge → Zustände → Suche nach `binary_sensor.*uberfallig`

**Tests:**
1. Keine Aufgaben überfällig → Zustand: `off`
2. Setze Fälligkeitsdatum auf gestern → Zustand: `on`
3. Hake die Aufgabe ab → Zustand: `off`

**Attribute prüfen:**
```yaml
overdue_tasks:
  - title: "Aufgabe 1"
    due_date: "2026-03-22"
    assigned_person: null
overdue_count: 1
```

---

## 3. Services testen

### 3.1 add_task

**Wo:** Entwicklerwerkzeuge → Aktionen

**YAML kopieren und einfügen:**

```yaml
action: my_todo_list.add_task
data:
  list_name: "Einkaufsliste"
  title: "Milch kaufen"
```

**Mit Person und Fälligkeitsdatum:**
```yaml
action: my_todo_list.add_task
data:
  list_name: "Einkaufsliste"
  title: "Brot kaufen"
  assigned_person: "person.max"
  due_date: "2026-03-25"
```

**Prüfen:** In der Card sollte die neue Aufgabe erscheinen.

### 3.2 complete_task

**Per Titel:**
```yaml
action: my_todo_list.complete_task
data:
  list_name: "Einkaufsliste"
  task_title: "Milch kaufen"
```

**Prüfen:** Aufgabe sollte als erledigt markiert sein.

### 3.3 assign_task

```yaml
action: my_todo_list.assign_task
data:
  list_name: "Einkaufsliste"
  task_title: "Brot kaufen"
  person: "person.max"
```

**Prüfen:** Aufgabe aufklappen → Person sollte ausgewählt sein.

### 3.4 Fehlerszenarien

**Liste nicht gefunden:**
```yaml
action: my_todo_list.add_task
data:
  list_name: "Gibt es nicht"
  title: "Test"
```
→ Sollte Fehlermeldung zeigen

**Aufgabe nicht gefunden:**
```yaml
action: my_todo_list.complete_task
data:
  list_name: "Einkaufsliste"
  task_title: "Gibt es nicht"
```
→ Sollte Fehlermeldung zeigen

---

## 4. Beispiel-Automationen

### 4.1 Benachrichtigung bei fälligen Aufgaben

```yaml
alias: "ToDo - Fällige Aufgabe"
description: "Benachrichtigung wenn eine Aufgabe fällig ist"
triggers:
  - trigger: event
    event_type: my_todo_list_task_due
actions:
  - action: notify.mobile_app_dein_handy
    data:
      title: "Aufgabe fällig!"
      message: "{{ trigger.event.data.task_title }} ist heute fällig."
```

### 4.2 Benachrichtigung bei überfälligen Aufgaben

```yaml
alias: "ToDo - Überfällige Aufgabe"
description: "Benachrichtigung bei überfälligen Aufgaben"
triggers:
  - trigger: event
    event_type: my_todo_list_task_overdue
actions:
  - action: notify.mobile_app_dein_handy
    data:
      title: "Aufgabe überfällig!"
      message: >
        {{ trigger.event.data.task_title }} war am
        {{ trigger.event.data.due_date }} fällig!
      data:
        color: red
```

### 4.3 Zugewiesene Person benachrichtigen

```yaml
alias: "ToDo - Zuweisung"
description: "Person benachrichtigen wenn eine Aufgabe zugewiesen wird"
triggers:
  - trigger: event
    event_type: my_todo_list_task_assigned
conditions:
  - condition: template
    value_template: "{{ trigger.event.data.assigned_person is not none }}"
actions:
  - action: notify.mobile_app_dein_handy
    data:
      title: "Neue Aufgabe zugewiesen"
      message: >
        Dir wurde die Aufgabe "{{ trigger.event.data.task_title }}" zugewiesen.
```

### 4.4 Wiederkehrende Aufgabe wiedereröffnet

```yaml
alias: "ToDo - Aufgabe wiedereröffnet"
description: "Benachrichtigung wenn wiederkehrende Aufgabe zurückgesetzt wird"
triggers:
  - trigger: event
    event_type: my_todo_list_task_reopened
actions:
  - action: notify.mobile_app_dein_handy
    data:
      title: "Aufgabe wieder offen"
      message: >
        Die wiederkehrende Aufgabe "{{ trigger.event.data.task_title }}"
        wurde wieder geöffnet.
```

### 4.5 Aufgabe per Automation erstellen

```yaml
alias: "ToDo - Montags Müll rausbringen"
description: "Jeden Montag eine Aufgabe erstellen"
triggers:
  - trigger: time
    at: "07:00:00"
conditions:
  - condition: time
    weekday:
      - mon
actions:
  - action: my_todo_list.add_task
    data:
      list_name: "Haushalt"
      title: "Müll rausbringen"
      due_date: "{{ now().strftime('%Y-%m-%d') }}"
```

### 4.6 Dashboard-Badge bei überfälligen Aufgaben

```yaml
alias: "ToDo - Überfällig-Warnung"
description: "Warnung wenn Aufgaben überfällig sind"
triggers:
  - trigger: state
    entity_id: binary_sensor.einkaufsliste_uberfallig
    to: "on"
actions:
  - action: notify.mobile_app_dein_handy
    data:
      title: "Überfällige Aufgaben!"
      message: >
        Du hast {{ state_attr('binary_sensor.einkaufsliste_uberfallig', 'overdue_count') }}
        überfällige Aufgabe(n) in deiner Einkaufsliste.
```

---

## Checkliste

- [ ] Event: task_created wird gefeuert
- [ ] Event: task_completed wird gefeuert
- [ ] Event: task_assigned wird gefeuert (mit previous_person)
- [ ] Event: task_due wird gefeuert (1x/Tag, stündlicher Check)
- [ ] Event: task_overdue wird gefeuert (1x/Tag)
- [ ] Event: task_reopened wird gefeuert
- [ ] Sensor: Offene Aufgaben zählt korrekt
- [ ] Sensor: Attribute (open_task_titles, overdue_count) stimmen
- [ ] Sensor: Aktualisiert sich sofort bei Änderungen
- [ ] Binary Sensor: on bei überfälligen Aufgaben
- [ ] Binary Sensor: off wenn keine überfällig
- [ ] Service: add_task per Listenname
- [ ] Service: add_task mit Person + Datum
- [ ] Service: complete_task per Aufgabentitel
- [ ] Service: assign_task funktioniert
- [ ] Service: Fehlermeldung bei unbekannter Liste
- [ ] Service: Fehlermeldung bei unbekannter Aufgabe
