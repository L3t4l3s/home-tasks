"""Constants for the Home Tasks integration."""

DOMAIN = "home_tasks"
STORAGE_VERSION = 1

# --- Security limits ---
MAX_LISTS = 50
MAX_TASKS_PER_LIST = 500
MAX_SUB_TASKS_PER_TASK = 50
MAX_TITLE_LENGTH = 255
MAX_LIST_NAME_LENGTH = 100
MAX_NOTES_LENGTH = 5000
MAX_REORDER_IDS = 500
MAX_TAGS_PER_TASK = 20
MAX_TAG_LENGTH = 50
MAX_SECTIONS_PER_LIST = 50
MAX_SECTION_NAME_LENGTH = 100

# --- Recurrence ---
VALID_RECURRENCE_UNITS = ("hours", "days", "weeks", "months", "years")

# Every user-facing recurrence field, in one place. Copying a task (move,
# duplicate) walks this list; a new field added here travels everywhere.
# recurrence_remaining_count is bookkeeping, not configuration, and is
# derived from recurrence_max_count by whoever creates the task.
RECURRENCE_FIELDS = (
    "recurrence_enabled", "recurrence_type", "recurrence_value", "recurrence_unit",
    "recurrence_weekdays", "recurrence_start_date", "recurrence_time",
    "recurrence_end_type", "recurrence_end_date", "recurrence_max_count",
    "recurrence_month_pattern", "recurrence_day_of_month", "recurrence_nth_week",
    "recurrence_anniversary",
)
RECURRENCE_UNIT_SECONDS = {
    "hours": 3600,
    "days": 86400,
    "weeks": 604800,
    "months": 2592000,  # 30 days
    "years": 31536000,  # 365 days
}
MAX_RECURRENCE_VALUE = 365

VALID_MONTH_PATTERNS = ("day_of_month", "nth_weekday")
VALID_NTH_WEEK = (1, 2, 3, 4, "last")

# --- Reminders ---
MAX_REMINDERS_PER_TASK = 5
MAX_REMINDER_OFFSET_MINUTES = 43200  # 30 days

# --- Images ---
MAX_IMAGE_URL_LENGTH = 2048
