import sqlite3
from contextlib import contextmanager


class Store:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL,
                    owner TEXT NOT NULL, repository TEXT NOT NULL UNIQUE,
                    budget REAL NOT NULL CHECK(budget >= 0),
                    planned_days REAL NOT NULL CHECK(planned_days >= 0),
                    actual_days REAL NOT NULL CHECK(actual_days >= 0),
                    status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS usage (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    day TEXT NOT NULL, model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
                    output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
                    cost REAL NOT NULL CHECK(cost >= 0), source TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS commits (
                    project_id TEXT NOT NULL REFERENCES projects(id), sha TEXT NOT NULL,
                    day TEXT NOT NULL, author TEXT NOT NULL, additions INTEGER,
                    source TEXT NOT NULL, PRIMARY KEY(project_id, sha)
                );
                CREATE INDEX IF NOT EXISTS usage_period ON usage(day, project_id);
                CREATE INDEX IF NOT EXISTS commit_period ON commits(day, project_id);
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ui_ids (
                    ui_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id)
                );
                CREATE TABLE IF NOT EXISTS monitoring (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id), state TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS repository_links (
                    project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL UNIQUE,
                    PRIMARY KEY(project_id, repository)
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def projects(self, include_deleted=False):
        with self.connect() as db:
            return [dict(r) for r in db.execute("""SELECT p.* FROM projects p LEFT JOIN monitoring m
                ON p.id=m.project_id WHERE (? OR COALESCE(m.state,'ACTIVE') != 'DELETED') ORDER BY p.id""", (include_deleted,))]

    def upsert_projects(self, rows):
        with self.connect() as db:
            for row in rows:
                db.execute("""INSERT INTO projects VALUES (:id,:name,:team,:owner,:repository,
                    :budget,:planned_days,:actual_days,:status)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name, team=excluded.team,
                    owner=excluded.owner, repository=excluded.repository, budget=excluded.budget,
                    planned_days=excluded.planned_days, actual_days=excluded.actual_days,
                    status=excluded.status""", row)

    def insert_usage(self, rows):
        with self.connect() as db:
            before = db.total_changes
            db.executemany("INSERT OR IGNORE INTO usage VALUES (:id,:project_id,:day,:model,"
                           ":input_tokens,:output_tokens,:cost,:source)", rows)
            return db.total_changes - before

    def insert_commits(self, rows):
        with self.connect() as db:
            before = db.total_changes
            db.executemany("INSERT OR IGNORE INTO commits VALUES (:project_id,:sha,:day,"
                           ":author,:additions,:source)", rows)
            return db.total_changes - before
