#!/usr/bin/env bash
# Move issues to the GQ-Support project column that matches their state and labels.
#
# Usage: scripts/sync-project-status.sh [issue-number...]
#   With issue numbers, syncs just those issues. Without, syncs every open issue
#   in the repository plus every issue already on the project.
#
# Closed issues go to Done. Open issues go to the column of their furthest-along
# label (see docs/agents/triage-labels.md); open issues without one are left
# where they are. Closed issues are never added to the project, only moved.
#
# Needs a gh token with the `project` scope (or a fine-grained token with
# organization Projects read/write and repository Issues read).
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-Quick-Release/gq-support}"
PROJECT_OWNER="${PROJECT_OWNER:-Quick-Release}"
PROJECT_NUMBER="${PROJECT_NUMBER:-7}"
STATUS_FIELD="Status"

# Furthest stage first: an issue carrying several labels lands in the later column.
LABEL_COLUMNS=(
	"ready-for-human=Ready for human"
	"ready-for-agent=Ready for agent"
	"needs-tickets=Needs tickets"
	"needs-spec=Needs spec"
	"wayfinder:grilling=Needs grilling"
	"wayfinder:research=Needs research"
	"needs-triage=Needs triage"
)
CLOSED_COLUMN="Done"

owner="${REPO%%/*}"
name="${REPO#*/}"

project_id="$(gh project view "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --jq .id)"
field_json="$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json \
	--jq ".fields[] | select(.name == \"$STATUS_FIELD\")")"
field_id="$(jq -r .id <<<"$field_json")"

option_id() {
	jq -r --arg n "$1" '.options[] | select(.name == $n) | .id' <<<"$field_json"
}

target_column() { # $1 = state, $2 = newline-separated labels
	if [[ "$1" == "CLOSED" ]]; then
		echo "$CLOSED_COLUMN"
		return
	fi
	local pair
	for pair in "${LABEL_COLUMNS[@]}"; do
		if grep -qxF "${pair%%=*}" <<<"$2"; then
			echo "${pair#*=}"
			return
		fi
	done
}

sync_issue() {
	local number="$1" issue state labels url column item_id current opt
	issue="$(gh api graphql -F owner="$owner" -F name="$name" -F number="$number" -f query='
		query($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				issue(number: $number) {
					url state
					labels(first: 50) { nodes { name } }
					projectItems(first: 50) {
						nodes { id project { id } fieldValueByName(name: "Status") {
							... on ProjectV2ItemFieldSingleSelectValue { name } } }
					}
				}
			}
		}' --jq '.data.repository.issue')"
	if [[ -z "$issue" || "$issue" == "null" ]]; then
		echo "#$number: not an issue, skipped"
		return
	fi

	state="$(jq -r .state <<<"$issue")"
	labels="$(jq -r '.labels.nodes[].name' <<<"$issue")"
	url="$(jq -r .url <<<"$issue")"
	column="$(target_column "$state" "$labels")"
	if [[ -z "$column" ]]; then
		echo "#$number: no column label, left alone"
		return
	fi

	item_id="$(jq -r --arg p "$project_id" '.projectItems.nodes[] | select(.project.id == $p) | .id' <<<"$issue")"
	current="$(jq -r --arg p "$project_id" '.projectItems.nodes[] | select(.project.id == $p) | .fieldValueByName.name // ""' <<<"$issue")"
	if [[ -z "$item_id" ]]; then
		if [[ "$state" == "CLOSED" ]]; then
			echo "#$number: closed and not on the project, skipped"
			return
		fi
		item_id="$(gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --url "$url" --format json --jq .id)"
	elif [[ "$current" == "$column" ]]; then
		echo "#$number: already in $column"
		return
	fi

	opt="$(option_id "$column")"
	if [[ -z "$opt" ]]; then
		echo "#$number: project has no '$column' column" >&2
		return 1
	fi
	gh project item-edit --project-id "$project_id" --field-id "$field_id" --id "$item_id" \
		--single-select-option-id "$opt" >/dev/null
	echo "#$number: ${current:-no status} -> $column"
}

if (($# > 0)); then
	numbers=("$@")
else
	mapfile -t numbers < <(
		{
			gh issue list --repo "$REPO" --state open --limit 1000 --json number --jq '.[].number'
			gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --limit 1000 --format json \
				--jq ".items[].content | select(.type == \"Issue\" and .repository == \"$REPO\") | .number"
		} | sort -nu
	)
fi

for number in "${numbers[@]}"; do
	sync_issue "$number"
done
