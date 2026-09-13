import json
import os
import sqlite3
import sys


def main():
    payload = json.load(sys.stdin)
    path = payload["path"]
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with sqlite3.connect(path, timeout=10) as db:
        os.chmod(path, 0o600)
        db.execute("CREATE TABLE IF NOT EXISTS prompt_modes (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT value FROM prompt_modes WHERE key = ?", (payload["key"],)).fetchone()
        current = json.loads(row[0]) if row else None
        if payload["action"] == "save":
            if (current or {}).get("revision", 0) != payload["expectedRevision"]:
                print(json.dumps({"conflict": True}))
                return
            current = payload["value"]
            db.execute("INSERT INTO prompt_modes(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (payload["key"], json.dumps(current)))
        print(json.dumps({"value": current}))


if __name__ == "__main__":
    main()
