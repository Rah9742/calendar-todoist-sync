# Sync behaviour

These are the implemented policies, not a record of any particular installation.

## Scope and initial imports

Only explicit one-to-one mappings participate. Unmapped calendars/projects, declined invitations and special Google event types are excluded. Undated new tasks wait until scheduled. New imports use today's London date through today plus `HORIZON_DAYS`, end exclusive. Existing links continue after leaving that range.

New sources normally create counterparts. Existing counterparts need explicit reviewed adoption; names/times alone are not a durable identity. Initial adoption can stage Google-authoritative values while keeping concurrent Todoist edits held.

## Ordinary edits

Titles, descriptions and dates/durations sync both ways. Google updates use ETags and `sendUpdates=none`. Provider-specific metadata is preserved where writes permit it. Date-only tasks cannot express a multi-day span, so an existing Google span is retained when the date has not changed. When Todoist does not return timed duration, linked Google duration is preserved. New timed tasks default to `DEFAULT_DURATION_MINUTES`.

Each side is compared with its own saved snapshot. A one-sided change propagates; identical echoes do nothing. Conflicting simultaneous changes hold the pair for review. Todoist does not offer equivalent conditional writes here, so a read/write race cannot be eliminated completely.

## Completion and reopening

`COMPLETION_MODE=retain` leaves existing Google events unchanged. Completion is never inferred from missing/deleted data. A completed task that disappears from an active-task endpoint is not sufficient deletion evidence.

For native recurring pairs, Todoist advances its own due occurrence while Google retains the series anchor. For rolling Todoist rules, completion creates the next ordinary Google event and retains completed events. Activities are consumed in order so delayed webhooks or rapid completions do not drop intermediate occurrences.

Reopening retains Google history. If undo rewinds a rolling task to a known historical occurrence, its existing link is reactivated and the next event is parked rather than deleted. Re-completion can reuse that parked event. Missing/ambiguous history requires review.

## Recurrence

| Source/pattern                                                                  | Representation                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Equivalent daily or single-weekday weekly rule                                  | Native series/task pair                                                        |
| Monthly fixed days 1–28; yearly fixed dates except leap day, with extended flag | Native pair                                                                    |
| Complex/finite Google rules or individual exceptions, with complex flag         | One Todoist task per Google-expanded occurrence                                |
| Todoist rule that cannot translate exactly, with complex flag                   | Native Todoist task plus ordinary Google events for successive due occurrences |

Native intervals are bounded by the supported parser; unsupported shapes are never approximated into a different native rule. Google expands its own complex rules and exceptions. Projection preserves an existing native task's identity and completion cursor; completed earlier occurrences are not recreated as fresh tasks.

A Todoist native rule change splits Google's future schedule at the pending occurrence, retaining the old historical series. If there are no past occurrences, the obsolete future series is retired. An individual due override converts to occurrence tasks. A same-anchor Google clock change retimes Todoist's next occurrence without rewinding it. Floating ambiguous/nonexistent DST times are rejected for review.

Projection is bounded to 200 incomplete active occurrence tasks per mapping and 200 instances per discovery chain, using five-item pages. Completion-history queries are bounded too; a backlog beyond the supported page is surfaced instead of silently skipping history.

## Deletions and moves

Deletion flags are opt-in per mapping. Confirmed Google cancellation deletes linked Todoist tasks, including completed tasks. Confirmed Todoist deletion removes the **current** linked Google counterpart. A native recurring task can represent an entire Google series; an occurrence task represents only its instance. Completed rolling Google history remains after deleting the current task.

Moves require both mappings to opt in. Task moves use Google event moves; moving one projected occurrence detaches it as an independent destination event and cancels only its original instance. Google moves retain Todoist identity. Clients such as Apple Calendar can replace both IDs: correlation requires a unique recently created copy matching content, dates, recurrence and relevant metadata, with a short deletion grace period for copy/delete ordering. Changed/ambiguous copies and concurrent delete/move races require review. This is not automatic migration matching.

## Alerts and recovery

Google incremental recovery and watch checks run every 15 minutes. Full project, link and rolling-window discovery run every six hours. Webhooks are the primary update path; no deadline is guaranteed.

Optional Gmail send-only alerts contain mapping labels and operational reasons, not event/task bodies. Active-mapping failures must persist for 30 minutes or exhaust retries; other health problems must be observed for 30 minutes. Retired mappings cannot promote new retries. Problem notices share a 24-hour budget even if counts/categories change or the service recovers in between. One recovery notice follows a delivered problem notice only after 30 minutes of observed healthy status. Ambiguous delivery is recorded rather than blindly re-sent. Worker, database and Google-credential outages can also prevent sending alerts.
