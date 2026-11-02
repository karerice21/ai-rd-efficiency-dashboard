from scripts import security_scan as scanner


def test_scanner_detects_private_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "ROOT", tmp_path)
    path = tmp_path / ".env"
    path.write_text("GITEE_TOKEN=" + "example-unsafe-value\n" + "sk-" + "X" * 32 + "\n" + "192.168." + "50.20\n" + scanner.FORBIDDEN_MARKER)
    rules = {r["rule"] for r in scanner.scan([path])}
    assert {"private-env-file", "nonempty-credential-configuration", "credential-pattern", "non-loopback-ip", "forbidden-organization-identifier"} <= rules


def test_scanner_allows_safe_example(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "ROOT", tmp_path)
    path = tmp_path / ".env.example"
    path.write_text("GITEE_TOKEN=\n# https://example.com/orbit-demo/repo.git\n")
    assert scanner.scan([path]) == []
