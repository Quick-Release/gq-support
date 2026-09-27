#!/usr/bin/env python3
"""Compare 100 warm public requests on the same disposable DDEV WordPress site."""
import json
import pathlib
import shutil
import statistics
import subprocess
import sys

URL = "https://gq-support-lifecycle-testsite.ddev.site/?gq_probe=1"
COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 100
LOG = "/tmp/gq-lifecycle-probe.jsonl"


def wp(*args):
    subprocess.run(["ddev", "wp", "--path=.test-site", *args], check=True, stdout=subprocess.DEVNULL)


def sample():
    subprocess.run(["ddev", "exec", "rm", "-f", LOG], check=True, stdout=subprocess.DEVNULL)
    sizes = []
    for _ in range(COUNT):
        result = subprocess.run(["curl", "-fsS", URL], check=True, capture_output=True)
        if b'/plugins/gq-support/' in result.stdout or b'gq-support-root' in result.stdout:
            raise RuntimeError('Public page references a GQ asset or launcher')
        sizes.append(len(result.stdout))
    data = subprocess.run(["ddev", "exec", "--", "cat", LOG], check=True, capture_output=True, text=True).stdout
    rows = [json.loads(line) for line in data.splitlines()]
    if len(rows) != COUNT:
        raise RuntimeError(f"Expected {COUNT} instrumented requests, got {len(rows)}")
    for row, size in zip(rows, sizes):
        row["response_bytes"] = size
        row["gq_asset_bytes"] = 0  # Verified absent from the sampled HTML above.
    return rows


def report(name, rows):
    print(name)
    for key in rows[0]:
        values = sorted(row[key] for row in rows)
        print(f"  {key}: median={statistics.median(values):.2f} p95={values[int(.95 * len(values)) - 1]:.2f}")


probe = pathlib.Path('.test-site/wp-content/mu-plugins/gq-lifecycle-probe.php')
probe.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile('plugin/tests/integration/benchmark.php', probe)
subprocess.run(["ddev", "mutagen", "sync"], check=True, stdout=subprocess.DEVNULL)
wp("config", "set", "SAVEQUERIES", "true", "--raw")
network = subprocess.run(
    ["ddev", "wp", "--path=.test-site", "eval", "echo is_multisite() ? 'yes' : 'no';"],
    check=True, capture_output=True, text=True,
).stdout.strip() == "yes"
flags = ("--network",) if network else ()
try:
    wp("plugin", "deactivate", "gq-support", *flags)
    for _ in range(5):
        subprocess.run(["curl", "-fsS", "-o", "/dev/null", URL], check=True)
    inactive = sample()
    wp("plugin", "activate", "gq-support", *flags)
    for _ in range(5):
        subprocess.run(["curl", "-fsS", "-o", "/dev/null", URL], check=True)
    active = sample()
    report("Inactive", inactive)
    report("Active", active)
finally:
    wp("plugin", "activate", "gq-support", *flags)
    probe.unlink()
    subprocess.run(["ddev", "mutagen", "sync"], check=True, stdout=subprocess.DEVNULL)
