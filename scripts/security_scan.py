#!/usr/bin/env python3
"""Scan only the prospective Git artifact; never print matched secret values.

Optional --deny-file reads an untracked, local-only list of forbidden identifiers.
The list is never copied into the repository or included in this report.
"""
import argparse
import ipaddress
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED = {".git", ".venv", "__pycache__", ".pytest_cache", "runtime", "node_modules", "test-results", ".cache"}
ALLOWED_HOSTS = {"example.com", "gitee.com", "github.com", "localhost", "127.0.0.1", "docs.litellm.ai", "spdx.org", "pypi.org", "www.w3.org", "schemas.openxmlformats.org"}
FORBIDDEN_MARKER = "\u0063\u0066\u0063\u0061"
SECRET = re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)")


def candidates():
    result = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True)
    if result.returncode == 0 and result.stdout:
        return sorted(ROOT / p.decode() for p in result.stdout.split(b"\0") if p)
    return sorted(p for p in ROOT.rglob("*") if p.is_file() and not (set(p.relative_to(ROOT).parts) & EXCLUDED))


def scan(paths, deny=()):
    findings = []
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        if not path.is_file() or path.is_symlink():
            findings.append({"file": rel, "rule": "symlink-or-missing-file"}); continue
        if path.name.startswith(".env") and path.name != ".env.example":
            findings.append({"file": rel, "rule": "private-env-file"})
        if path.suffix in {".db", ".sqlite3", ".csv", ".xlsx", ".log", ".pem", ".key", ".whl", ".zip"} or set(path.relative_to(ROOT).parts) & EXCLUDED:
            findings.append({"file": rel, "rule": "private-or-runtime-file"})
        content = path.read_bytes()
        if b"\0" in content and path.suffix not in {".png", ".jpg", ".jpeg"}:
            findings.append({"file": rel, "rule": "unreviewed-binary"}); continue
        if path.suffix in {".png", ".jpg", ".jpeg"}: continue
        try: text = content.decode("utf-8")
        except UnicodeDecodeError:
            findings.append({"file": rel, "rule": "unreviewed-encoding"}); continue
        for line, value in enumerate(text.splitlines(), 1):
            rules = set()
            if path.name.startswith(".env"):
                assignment = re.match(r"\s*[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z_]*\s*=\s*(.+)", value)
                if assignment and assignment.group(1).strip() not in {'""', "''"}:
                    rules.add("nonempty-credential-configuration")
            if FORBIDDEN_MARKER in value.lower() or any(d.lower() in value.lower() for d in deny): rules.add("forbidden-organization-identifier")
            if SECRET.search(value): rules.add("credential-pattern")
            for match in re.findall(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", value):
                try:
                    if not ipaddress.ip_address(match).is_loopback: rules.add("non-loopback-ip")
                except ValueError: pass
            for email in re.findall(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", value):
                if not email.endswith("@example.com"): rules.add("non-example-account")
            # License source URLs belong to upstream authors; review their separate inventory.
            for url in re.findall(r"https?://[^\s\"'<>`)]+", value):
                try: host = urlsplit(url).hostname
                except ValueError: host = None
                if host not in ALLOWED_HOSTS and not rel.startswith("docs/dependency-licenses"):
                    # Negative security test fixtures deliberately exercise invalid origins.
                    if not (rel.startswith("tests/") and host and host.endswith(".example")):
                        rules.add("unreviewed-domain")
            findings.extend({"file": rel, "line": line, "rule": r} for r in sorted(rules))
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deny-file", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    deny = args.deny_file.read_text().splitlines() if args.deny_file else []
    paths = candidates()
    findings = scan(paths, [d.strip() for d in deny if len(d.strip()) >= 4])
    report = {"scope": "prospective Git files", "scanned_files": len(paths), "findings": findings,
              "passed": not findings, "limits": "Heuristic scan; images, intellectual property and business semantics require human review."}
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output: args.output.write_text(encoded)
    print(encoded)
    raise SystemExit(bool(findings))


if __name__ == "__main__": main()
