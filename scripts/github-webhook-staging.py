#!/usr/bin/env python3
"""Staging webhook rollout. Secrets travel through gh stdin, never files/argv.

Run each phase from the repo root; --state stores sanitized progress only.
The App's Active checkbox is the only browser step between setup and exercise.
"""
import argparse
import datetime
import json
import pathlib
import re
import secrets
import subprocess
import sys
import time
import uuid

REPO = "Quick-Release/gq-support"
SANDBOX = "Quick-Release/gq-support-sandbox"
SPIKE = "github-webhook-spike.yml"
DEPLOY = "deploy-worker.yml"


def gh(*args, stdin=None):
    result = subprocess.run(["gh", *args], input=stdin, text=True, capture_output=True)
    if result.returncode:
        # CLI errors may contain request data. Never echo captured output.
        raise RuntimeError(f"gh {args[0]} {args[1] if len(args) > 1 else ''} failed; inspect GitHub for status")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["setup", "exercise", "collect", "rotate", "redeliver", "retire", "finish", "report"])
    parser.add_argument("--state", default="/tmp/gq-support-55.json")
    args = parser.parse_args()
    path = pathlib.Path(args.state)
    state = json.loads(path.read_text()) if path.exists() else {
        "since": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "runs": [], "deliveries": [],
    }

    def save():
        path.write_text(json.dumps(state, indent=2) + "\n")

    def variable(name, value):
        gh("variable", "set", name, "--repo", REPO, "--env", "staging", "--body", value)

    def set_secret(name, value):
        gh("secret", "set", name, "--repo", REPO, "--env", "staging", stdin=value)

    def workflow(operation, delivery=None):
        workflow_file = DEPLOY if operation == "deploy" else SPIKE
        request_id = uuid.uuid4().hex
        command = ["workflow", "run", workflow_file, "--repo", REPO, "--ref", "main", "-f", f"request_id={request_id}"]
        if operation == "deploy":
            command += ["-f", "stage=staging"]
        else:
            command += ["-f", f"operation={operation}", "-f", f"since={state['since']}"]
        if delivery is not None:
            command += ["-f", f"delivery_id={delivery}"]
        gh(*command)
        deadline = time.monotonic() + 20 * 60
        run_id = None
        last_status = None
        while time.monotonic() < deadline:
            if run_id is None:
                runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", workflow_file, "--limit", "30",
                                     "--json", "databaseId,displayTitle,status,conclusion"))
                match = next((run for run in runs if request_id in run["displayTitle"]), None)
                if match:
                    run_id = match["databaseId"]
                    state["runs"].append({"operation": operation, "id": run_id,
                                           "url": f"https://github.com/{REPO}/actions/runs/{run_id}"})
                    save()
            if run_id is not None:
                run = json.loads(gh("run", "view", str(run_id), "--repo", REPO, "--json", "status,conclusion"))
                if run["status"] != last_status:
                    print(f"{operation}: {run['status']} — https://github.com/{REPO}/actions/runs/{run_id}", flush=True)
                    last_status = run["status"]
                if run["status"] == "completed":
                    if run["conclusion"] != "success":
                        raise RuntimeError(f"{operation} failed in run {run_id}; stop here and inspect that run")
                    if operation == "deploy":
                        return {}
                    logs = gh("run", "view", str(run_id), "--repo", REPO, "--log")
                    records = re.findall(r"GQ_WEBHOOK_EVIDENCE=(\{[^\n]+\})", logs)
                    if not records:
                        raise RuntimeError(f"run {run_id} produced no evidence")
                    return json.loads(records[-1])
            time.sleep(10)
        raise RuntimeError(f"{operation} timed out; inspect the saved run ID before retrying")

    def collect():
        evidence = workflow("collect")
        rows = {row["id"]: row for row in state["deliveries"]}
        rows.update({row["id"]: row for row in evidence["deliveries"]})
        state["deliveries"] = list(rows.values())
        save()
        print(f"Collected {len(evidence['deliveries'])} delivery observations", flush=True)

    def require(flag):
        if not state.get(flag):
            raise RuntimeError(f"complete {flag} before {args.phase}")

    if args.phase == "setup":
        if not state.get("secrets_created"):
            names = {entry["name"] for entry in json.loads(gh("secret", "list", "--repo", REPO, "--env", "staging", "--json", "name"))}
            if "SUPPORT_GITHUB_WEBHOOK_SECRET" in names:
                raise RuntimeError("current webhook secret already exists; use the original state file or inspect configuration before bootstrapping")
            initial = secrets.token_hex(32)
            # Duplicate encrypted source enables rotation without recovering a
            # secret from GitHub. Initially both keys contain the same value.
            set_secret("SUPPORT_GITHUB_WEBHOOK_SECRET", initial)
            set_secret("SUPPORT_GITHUB_WEBHOOK_PREVIOUS_SECRET", initial)
            del initial
            state["secrets_created"] = True
            save()
        variable("SUPPORT_GITHUB_APP_ID", "5355960")
        variable("SUPPORT_GITHUB_WEBHOOK_DIAGNOSTICS", "true")
        workflow("deploy")
        state["configuration"] = workflow("configure")
        state["initial_probe"] = workflow("probe")
        state["setup"] = True
        save()
        print("Now enable Active in the staging App's General settings. URL/secret/JSON/TLS were configured by CI.")
        print("https://github.com/organizations/Quick-Release/settings/apps/getquick-support-staging")
    elif args.phase == "exercise":
        require("setup")
        repository = json.loads(gh("api", f"repos/{SANDBOX}"))
        if not repository["private"] or repository["id"] != 1424354303:
            raise RuntimeError("sandbox identity/private-only check failed")
        if not state.get("sandbox_issue"):
            issue = json.loads(gh("api", f"repos/{SANDBOX}/issues", "--method", "POST", "--input", "-", stdin=json.dumps({
                "title": "Webhook receiver staging spike #55", "body": "Synthetic payload only.\n" + ("café 日本語 🐙  " * 3000),
            })))
            state["sandbox_issue"] = issue["number"]
            save()
        endpoint = f"repos/{SANDBOX}/issues/{state['sandbox_issue']}"
        for issue_state in ["closed", "open", "closed"]:
            gh("api", endpoint, "--method", "PATCH", "--input", "-", stdin=json.dumps({"state": issue_state}))
        state["installation_probe"] = workflow("installation")
        state["exercise"] = True
        save()
        collect()
        candidates = [row for row in state["deliveries"] if row["event"] == "issues" and row["status"] == 204 and row["bytes"]]
        if not candidates:
            raise RuntimeError("no verified real issue delivery yet; check Active, then run collect and exercise again")
        state["baseline"] = candidates[0]
        save()
    elif args.phase == "collect":
        require("setup")
        collect()
    elif args.phase == "rotate":
        require("exercise")
        if not state.get("rotation_secret_set"):
            set_secret("SUPPORT_GITHUB_WEBHOOK_SECRET", secrets.token_hex(32))
            state["rotation_secret_set"] = True
            save()
        workflow("deploy")
        state["overlap_probe"] = workflow("probe")
        workflow("configure")
        state["rotate"] = True
        save()
    elif args.phase == "redeliver":
        require("rotate")
        if not state.get("baseline"):
            raise RuntimeError("baseline delivery missing; collect a verified pre-rotation delivery first")
        workflow("redeliver", state["baseline"]["id"])
        collect()
        matches = [row for row in state["deliveries"] if row["redelivery"] and row["guid"] == state["baseline"]["guid"] and row["key"]]
        if not matches:
            raise RuntimeError("redelivery is asynchronous; run redeliver again after inspecting delivery state")
        state["rotation_redelivery"] = matches[-1]
        save()
    elif args.phase == "retire":
        require("rotation_redelivery")
        if state.get("retire"):
            print("Previous secret already retired; continue with finish")
            return
        state["retired_probe"] = workflow("retire")
        gh("secret", "delete", "SUPPORT_GITHUB_WEBHOOK_PREVIOUS_SECRET", "--repo", REPO, "--env", "staging")
        state["retire"] = True
        save()
    elif args.phase == "finish":
        require("retire")
        collect()
        for event in ["issues", "installation"]:
            if not any(row["event"] == event and row["status"] == 204 and row["bytes"] for row in state["deliveries"]):
                raise RuntimeError(f"missing verified {event} byte measurement; keep diagnostics on and collect it")
        variable("SUPPORT_GITHUB_WEBHOOK_DIAGNOSTICS", "false")
        workflow("deploy")
        state["final_probe"] = workflow("probe")
        if state["final_probe"]["current"]["key"] is not None:
            raise RuntimeError("diagnostic headers remain enabled; inspect the final deployment before completion")
        state["finish"] = True
        save()
    elif args.phase == "report":
        maxima = {}
        for row in state["deliveries"]:
            if row["status"] == 204 and row["bytes"]:
                maxima[row["event"]] = max(maxima.get(row["event"], 0), row["bytes"])
        print(json.dumps({"completed": [key for key in ["setup", "exercise", "rotate", "rotation_redelivery", "retire", "finish"] if state.get(key)],
                          "largest_raw_bytes": maxima, "redelivery": state.get("rotation_redelivery"),
                          "retired_probe": state.get("retired_probe"), "runs": state["runs"]}, indent=2))
    print(f"Sanitized progress: {path}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        sys.exit(1)
