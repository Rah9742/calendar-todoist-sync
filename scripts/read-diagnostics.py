"""Print only non-secret status fields from the ignored Wrangler tail file."""
import json
from pathlib import Path
from urllib.parse import urlsplit
path = Path('.wrangler/live-tail.jsonl')
raw = path.read_text() if path.exists() else ''
decoder = json.JSONDecoder()
events = []
i = 0
while i < len(raw):
    if raw[i] != '{':
        i += 1
        continue
    try:
        value, consumed = decoder.raw_decode(raw[i:])
        i += consumed
    except json.JSONDecodeError:
        i += 1
        continue
    if not isinstance(value, dict) or 'outcome' not in value:
        continue
    event = value.get('event') or {}
    result = {'outcome': value.get('outcome'), 'timestamp': value.get('eventTimestamp')}
    if 'request' in event:
        result['path'] = urlsplit(event['request'].get('url', '')).path
        result['http_status'] = event.get('response', {}).get('status')
    else:
        result['kind'] = 'queue' if 'queue' in event else 'scheduled'
    for key in ('cpuTime', 'wallTime'):
        if key in value:
            result[key] = value[key]
    codes = []
    for log in value.get('logs', []):
        for message in log.get('message', []):
            if not isinstance(message, str):
                continue
            try:
                parsed = json.loads(message)
                code = parsed.get('code', '')
                if isinstance(code, str) and code.replace('_', '').isalnum():
                    codes.append(code)
            except (ValueError, AttributeError):
                pass
    result['codes'] = codes
    result['exception_names'] = [e.get('name') for e in value.get('exceptions', [])]
    events.append(result)
for event in events[-20:]:
    print(json.dumps(event))
