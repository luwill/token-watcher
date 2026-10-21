"""Export only daily usage aggregates from the approved local SQLite source."""
import argparse
import calendar
import csv
import hashlib
import json
import re
import sqlite3
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


def safe_category(value, unknown):
    if value is None or value == "":
        return unknown
    value = str(value)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}", value) or re.match(
        r"(?:sk[-_]|ghp_|github_pat_|AKIA)", value, re.I
    ):
        return "未规范标识"
    return value


def export(db_path, out):
    zone = ZoneInfo("Asia/Taipei")
    captured = datetime.now(zone)
    end = captured.date()
    year, month = end.year, end.month - 6
    if month <= 0:
        month += 12
        year -= 1
    start = end.replace(year=year, month=month, day=min(end.day, calendar.monthrange(year, month)[1]))
    lo = int(datetime.combine(start, datetime.min.time(), zone).timestamp() * 1000)
    hi = int(captured.timestamp() * 1000)
    conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    predicate = "ts >= ? AND ts < ?"
    parameters = (lo, hi)
    query = f"""SELECT date(ts/1000, 'unixepoch', '+8 hours') day,
      tool, model, COALESCE(device, 'unknown') device,
      SUM(total_tokens) tokens, COUNT(*) events
      FROM events WHERE {predicate} GROUP BY day, tool, model, device ORDER BY day, tool, model, device"""
    records = []
    for day, tool, model, device, tokens, events in conn.execute(query, parameters):
        records.append(dict(day=day, tool=safe_category(tool, "未标注工具"),
                            model=safe_category(model, "未标注模型"),
                            device=device if device in ("local", "vps", "windows", "unknown") else "unknown",
                            tokens=int(tokens), events=events))
    n, total, negative, min_ts, max_ts = conn.execute(f"""SELECT COUNT(*), COALESCE(SUM(total_tokens),0),
      COALESCE(SUM(total_tokens<0),0), MIN(ts), MAX(ts) FROM events WHERE {predicate}""", parameters).fetchone()
    duplicate = conn.execute(f"SELECT COUNT(*)-COUNT(DISTINCT dedup_key) FROM events WHERE {predicate}", parameters).fetchone()[0]
    direct_tools = dict(conn.execute(f"SELECT tool, SUM(total_tokens) FROM events WHERE {predicate} GROUP BY tool", parameters))
    direct_days = dict(conn.execute(f"SELECT date(ts/1000,'unixepoch','+8 hours'), SUM(total_tokens) FROM events WHERE {predicate} GROUP BY 1", parameters))
    estimated = conn.execute(f"""SELECT COALESCE(SUM(total_tokens),0) FROM events
      WHERE {predicate} AND tool='antigravity' AND usage_quality<>3""", parameters).fetchone()[0]
    freshness = [dict(device=d, latestEvent=datetime.fromtimestamp(ts/1000, zone).isoformat())
                 for d, ts in conn.execute("SELECT device, MAX(ts) FROM events GROUP BY device") if ts]
    conn.rollback()
    conn.close()
    assert not negative and not duplicate, "Invalid token counts or duplicate keys"
    assert sum(r["tokens"] for r in records) == total
    assert sum(r["events"] for r in records) == n
    by_tool, by_day = Counter(), Counter()
    for r in records:
        by_tool[r["tool"]] += r["tokens"]
        by_day[r["day"]] += r["tokens"]
    assert all(by_tool[safe_category(k, "未标注工具")] == v for k, v in direct_tools.items())
    assert dict(by_day) == direct_days
    days = [(start + timedelta(days=i)).isoformat() for i in range((end-start).days+1)]
    payload = dict(version=1, timezone="Asia/Taipei", start=start.isoformat(), end=end.isoformat(),
                   capturedAt=captured.isoformat(), lastDayPartial=True, totalTokens=total, events=n,
                   days=days, rows=records, source="tokenmeter.db:events", metric="total_tokens",
                   devices=["local", "vps", "windows", "unknown"],
                   note="沿用仪表盘Total tokens口径，含缓存及日志估算；无记录的日期填0。末日尚未结束。",
                   antigravityNonExactTokens=estimated, freshness=freshness,
                   checks=dict(negativeCounts=negative, duplicateKeys=duplicate,
                               directToolTotalsMatch=True, directDayTotalsMatch=True,
                               minEvent=datetime.fromtimestamp(min_ts/1000, zone).isoformat() if min_ts else None,
                               maxEvent=datetime.fromtimestamp(max_ts/1000, zone).isoformat() if max_ts else None))
    out.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    (out/"daily-usage.json").write_bytes(data)
    with (out/"daily-usage.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["day", "tool", "model", "device", "tokens", "events"])
        writer.writeheader()
        writer.writerows(records)
    proof = dict(start=payload["start"], end=payload["end"], capturedAt=payload["capturedAt"],
                 days=len(days), activeDays=len(by_day), totalTokens=total, events=n,
                 aggregateRows=len(records), dataSha256=hashlib.sha256(data).hexdigest(),
                 tools=dict(by_tool.most_common()),
                 models=dict(Counter({m:sum(r["tokens"] for r in records if r["model"]==m)
                                      for m in set(r["model"] for r in records)}).most_common()),
                 deviceTotals={d:sum(r["tokens"] for r in records if r["device"]==d) for d in payload["devices"]},
                 peakDay=max(by_day, key=by_day.get), peakTokens=max(by_day.values()), checks=payload["checks"])
    (out/"data-validation.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(proof, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=Path.home()/".tokenmeter/tokenmeter.db")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    export(args.db, args.out)
