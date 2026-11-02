import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Settings:
    database_path: Path = field(default_factory=lambda: ROOT / "runtime" / "dashboard.sqlite3")
    seed_demo: bool = True
    gitee_enabled: bool = False
    gitee_token: str = ""
    max_upload_bytes: int = 2 * 1024 * 1024
    max_rows: int = 1000

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env", override=False)
        return cls(
            database_path=Path(os.getenv("DATABASE_PATH", str(ROOT / "runtime/dashboard.sqlite3"))),
            seed_demo=os.getenv("SEED_DEMO", "true").lower() == "true",
            gitee_enabled=os.getenv("GITEE_ENABLED", "false").lower() == "true",
            gitee_token=os.getenv("GITEE_TOKEN", ""),
            max_upload_bytes=int(os.getenv("MAX_UPLOAD_BYTES", "2097152")),
        )
