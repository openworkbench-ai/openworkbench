#!/usr/bin/env bash
# Exercises the project_hub manifest against a running pocketknife server.
# Requires: curl, jq. Run: bash test_project_hub.sh
set -uo pipefail

BASE="http://localhost:8080/apps/project_hub"

echo "######################################################"
echo "## 1. SEED: project, tag, parent task, child task,  ##"
echo "##    comment, log entry (all on the child task)    ##"
echo "######################################################"

PROJECT_ID=$(curl -s -X POST "$BASE/project" -H 'Content-Type: application/json' \
  -d '{"name":"Pocket Launch","description":"Ship the v1 runtime","budget":5000,"starred":true}' \
  | tee /dev/stderr | jq -r '.id')
echo

TAG_ID=$(curl -s -X POST "$BASE/tag" -H 'Content-Type: application/json' \
  -d '{"name":"backend","color":"blue"}' \
  | tee /dev/stderr | jq -r '.id')
echo

PARENT_TASK_ID=$(curl -s -X POST "$BASE/task" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Design manifest schema\",\"project\":\"$PROJECT_ID\",\"tag\":\"$TAG_ID\"}" \
  | tee /dev/stderr | jq -r '.id')
echo

CHILD_TASK_ID=$(curl -s -X POST "$BASE/task" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Write JSON Schema for manifest\",\"project\":\"$PROJECT_ID\",\"parent_task\":\"$PARENT_TASK_ID\",\"priority\":4}" \
  | tee /dev/stderr | jq -r '.id')
echo

COMMENT_ID=$(curl -s -X POST "$BASE/comment" -H 'Content-Type: application/json' \
  -d "{\"task\":\"$CHILD_TASK_ID\",\"body\":\"First pass done, needs review.\"}" \
  | tee /dev/stderr | jq -r '.id')
echo

LOG_ID=$(curl -s -X POST "$BASE/activity_log" -H 'Content-Type: application/json' \
  -d "{\"task\":\"$CHILD_TASK_ID\",\"action\":\"created\"}" \
  | tee /dev/stderr | jq -r '.id')
echo
echo "project=$PROJECT_ID tag=$TAG_ID parent=$PARENT_TASK_ID child=$CHILD_TASK_ID comment=$COMMENT_ID log=$LOG_ID"
echo

echo "######################################################"
echo "## 2. RESTRICT: delete the child task directly.     ##"
echo "##    It has a log entry pointing at it (restrict)  ##"
echo "##    -> should be BLOCKED, not 204.                ##"
echo "######################################################"
curl -s -i -X DELETE "$BASE/task/$CHILD_TASK_ID"
echo; echo

echo "######################################################"
echo "## 3. SET_NULL: delete the tag, re-fetch the parent ##"
echo "##    task -> 'tag' field should now be null.       ##"
echo "######################################################"
curl -s -i -X DELETE "$BASE/tag/$TAG_ID"
echo
curl -s "$BASE/task/$PARENT_TASK_ID" | jq .
echo

echo "######################################################"
echo "## 4. UNIQUE: duplicate tag name -> expect 409.     ##"
echo "######################################################"
curl -s -i -X POST "$BASE/tag" -H 'Content-Type: application/json' \
  -d '{"name":"backend","color":"green"}'
echo; echo
curl -s -i -X POST "$BASE/tag" -H 'Content-Type: application/json' \
  -d '{"name":"backend","color":"green"}'
echo; echo

echo "######################################################"
echo "## 5. VALIDATION: priority out of range, bad enum   ##"
echo "##    value -> expect 400 twice.                    ##"
echo "######################################################"
curl -s -i -X POST "$BASE/task" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Bad priority\",\"project\":\"$PROJECT_ID\",\"priority\":6}"
echo; echo
curl -s -i -X POST "$BASE/task" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Bad status\",\"project\":\"$PROJECT_ID\",\"status\":\"archived\"}"
echo; echo

echo "######################################################"
echo "## 6. DEFAULTS: minimal task -> confirm status/      ##"
echo "##    priority/completed come back as declared       ##"
echo "##    defaults (todo / 3 / false).                   ##"
echo "######################################################"
curl -s -X POST "$BASE/task" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Minimal task\",\"project\":\"$PROJECT_ID\"}" | jq .
echo

echo "######################################################"
echo "## 7. OPERATIONS SUBSET: activity_log is create+read ##"
echo "##    only -> PATCH and DELETE both expect 405.      ##"
echo "######################################################"
curl -s -i -X PATCH "$BASE/activity_log/$LOG_ID" -H 'Content-Type: application/json' \
  -d '{"note":"edit attempt"}'
echo; echo
curl -s -i -X DELETE "$BASE/activity_log/$LOG_ID"
echo; echo

echo "######################################################"
echo "## 8. QUERY SYNTAX: filter + sort + paginate,        ##"
echo "##    and a 'like' filter.                           ##"
echo "######################################################"
curl -s "$BASE/task?filter=priority:gte:4&sort=-due_at&limit=10" | jq .
curl -s "$BASE/task?filter=title:like:%25Schema%25" | jq .
echo

echo "######################################################"
echo "## 9. THE INTERESTING ONE: delete the project.       ##"
echo "##    project->task is cascade, but the child task   ##"
echo "##    still has a log entry pointing at it via       ##"
echo "##    restrict. Does the cascade get blocked          ##"
echo "##    transitively, or does it silently override the ##"
echo "##    restrict and orphan the log row? Watch closely.##"
echo "######################################################"
curl -s -i -X DELETE "$BASE/project/$PROJECT_ID"
echo; echo

echo "######################################################"
echo "## 10. CLEAN CASCADE: remove the blocker (the log   ##"
echo "##     entry) directly via SQL or a future delete    ##"
echo "##     route, then delete the project again ->       ##"
echo "##     should now fully cascade. (activity_log has   ##"
echo "##     no delete operation in the manifest, so if    ##"
echo "##     step 9 didn't already clear it you'll need to ##"
echo "##     remove it out-of-band to continue this check.)##"
echo "######################################################"
curl -s -i -X DELETE "$BASE/project/$PROJECT_ID"
echo
curl -s "$BASE/task?filter=project:eq:$PROJECT_ID" | jq .
curl -s -i "$BASE/comment/$COMMENT_ID"
echo
