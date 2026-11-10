# Adopting an existing installation

Inventory both providers before enabling overlapping mappings. Stop integrations that write the same items; a display-only view is different. Keep a separate backup. Similar titles/times can identify candidates for review but do not prove identity.

A mapping with `enabled:false` is excluded from normal jobs while remaining available for explicit administrative migration preparation. The authenticated `POST /admin/migration` accepts a mapping label and a bounded plan:

```json
{
  "mapping": "work",
  "plan": {
    "pairs": [
      { "eventId": "EXPLICIT_GOOGLE_ID", "taskId": "EXPLICIT_TODOIST_ID" }
    ],
    "guards": [{ "source": "google", "id": "EXCLUDED_GOOGLE_ID" }]
  }
}
```

Send the admin token only in the Authorization header using a private local client. Plans are serialized, validate current provider values, and reject collisions. Equivalent pairs can be adopted without provider writes. Add `"authority":"google"` to a reviewed pair to stage a Todoist-only initial import; an intervening Todoist edit holds the pair instead of being overwritten.

For recurring adoption, verify native rule equivalence and the actual Google instance corresponding to Todoist's current pending occurrence. Preserve the original Google anchor. Unsupported exceptions or ambiguous schedules require review; never adopt by comparing only master titles.

Guards exclude a source from automatic creation. Replaying preparation does not reset existing snapshots or release holds. After reviewing the prepared state, enable only that mapping and reconcile. Do not submit migration plans against an active mapping.

Retiring a mapping is a configuration change: remove/disable it and deploy before deleting its provider calendar/project. Historical D1 links are retained unless deliberately purged. Removing a mapping does not delete its old counterparts automatically.
