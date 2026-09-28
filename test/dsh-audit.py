"""Read-only independent DSH reconciliation: python3 test/dsh-audit.py [sessions-root].

Requires the zstd CLI. Prints aggregate counts only, never conversation contents.
Unlike the collector, refuses to pick a winner if copies disagree on usage.
"""
import collections
import json
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.dsh/sessions'
zstd = shutil.which('zstd')
if not zstd:
    raise SystemExit('Install the zstd CLI first.')
fields = ('inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens')
requests = collections.defaultdict(list)
paths = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix in ('.zst', '.zstd'))
records = raw_total = mismatched_totals = fallback_records = 0
for path in paths:
    text = subprocess.check_output([zstd, '-dc', str(path)], stderr=subprocess.DEVNULL)
    for line in text.splitlines():
        if b'"usage"' not in line:
            continue
        rec = json.loads(line)
        data = rec.get('data') or {}
        if rec.get('type') == 'assistant/message':
            usage = data.get('usage')
            fallback = (str(path.parent), path.name, rec.get('seq'))
        elif rec.get('type') == 'assistant/chunk' and (data.get('chunk') or {}).get('type') == 'usage':
            usage = data['chunk'].get('usage')
            fallback = (str(path.parent), rec.get('seq'), data.get('turn'), data.get('step'))
        else:
            continue
        if not usage:
            continue
        values = tuple(usage.get(f, 0) or 0 for f in fields)
        total = sum(values[:4])  # reasoning is already part of output
        if total <= 0:
            continue
        identity = (data.get('turn'), data.get('step'))
        valid = all(type(v) is int and 0 <= v <= 2**53 - 1 for v in identity)
        key = ('request', str(path.parent), *identity) if valid else ('fallback', *fallback)
        requests[key].append(values)
        fallback_records += not valid
        records += 1
        raw_total += total
        mismatched_totals += usage.get('totalTokens', total) != total

conflicts = sum(len(set(copies)) > 1 for copies in requests.values())
report = {
    'files': len(paths),
    'sessions': len({p.parent for p in paths}),
    'raw_usage_records': records,
    'raw_tokens': raw_total,
    'unique_requests': len(requests),
    'unique_tokens': None if conflicts else sum(sum(copies[0][:4]) for copies in requests.values()),
    'unique_reasoning_tokens': None if conflicts else sum(copies[0][4] for copies in requests.values()),
    'conflicting_requests': conflicts,
    'fallback_records': fallback_records,
    'declared_total_mismatches': mismatched_totals,
}
print(json.dumps(report, indent=2))
sys.exit(1 if conflicts or mismatched_totals else 0)
