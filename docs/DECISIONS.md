# Behaviour to decide before live writes

Confirmed: near-real-time two-way sync and multiple explicit calendar/project mappings.

The following are proposals or open decisions, not approved behaviour:

- Completing a task: proposed default is retain the event and prefix its title with a checkmark; reopening should reverse that marker.
- Deleting a task/event: decide whether deletion propagates in each direction. Never infer completion from deletion.
- Recurrence: decide how calendar occurrences map to Todoist tasks and how Todoist recurring tasks export; avoid duplicate series and occurrence expansion without a bounded horizon.
- Undated tasks: decide whether to leave unsynced until scheduled; date-only tasks can map to all-day events.
- Conflict handling: define deterministic rules for simultaneous edits and retain enough state for recovery.
- Project/calendar moves: define whether a mapped move relocates the linked item.
- Scope: choose import horizon, which event types to include, and handling of declined events and shared meetings. Avoid attendee notifications unless explicitly intended.
- Migration: inventory existing synced items before creating replacements. Avoid simultaneous native/custom writers for the same items.
