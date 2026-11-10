#!/usr/bin/env bash
# shellcheck shell=bash

# Source this file only from a shell that has enabled `set -euo pipefail`.
# The caller must set API_BASE and DEPLOY_DIR.

cf_api() {
  local request_method=$1
  local request_url=$2
  shift 2
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl --config - --fail-with-body --silent --show-error \
      --request "$request_method" "$request_url" "$@"
}

cf_api_receipt() {
  local request_method=$1
  local request_url=$2
  local receipt_prefix=$3
  shift 3

  local receipt="$DEPLOY_DIR/$receipt_prefix.json"
  local status_receipt="$DEPLOY_DIR/$receipt_prefix.http-status"
  local http_status
  local curl_status=0

  : > "$receipt"
  if http_status="$(
    cf_api "$request_method" "$request_url" \
      --output "$receipt" --write-out '%{http_code}' "$@"
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi
  printf '%s\n' "$http_status" > "$status_receipt"

  if (( curl_status != 0 )); then
    return "$curl_status"
  fi
  test "$http_status" = 200
}

read_snippet_rules() {
  local receipt_prefix=$1
  local receipt="$DEPLOY_DIR/$receipt_prefix.json"
  local status_receipt="$DEPLOY_DIR/$receipt_prefix.http-status"
  local state_receipt="$DEPLOY_DIR/$receipt_prefix.state"
  local payload_receipt="$DEPLOY_DIR/$receipt_prefix.payload.json"
  local canonical_receipt="$DEPLOY_DIR/$receipt_prefix.canonical.json"
  local http_status
  local curl_status=0

  : > "$receipt"
  if http_status="$(
    cf_api GET "$API_BASE/snippet_rules" \
      --output "$receipt" --write-out '%{http_code}'
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi
  printf '%s\n' "$http_status" > "$status_receipt"

  if (( curl_status == 0 )); then
    test "$http_status" = 200 || return 1
    jq -e '.success == true and (.result | type == "array")' "$receipt" \
      > /dev/null || return 1
    printf 'present\n' > "$state_receipt" || return 1
    jq -S '.result' "$receipt" > "$payload_receipt" || return 1
    jq -S '.result | map(del(.id, .last_updated))' "$receipt" \
      > "$canonical_receipt" || return 1
    return
  fi

  if (( curl_status == 22 )) \
    && test "$http_status" = 404 \
    && jq -e '
      .success == false and
      (.errors | type == "array") and
      (.errors | length == 1) and
      .errors[0].code == 10003
    ' "$receipt" > /dev/null; then
    printf 'absent\n' > "$state_receipt" || return 1
    printf '[]\n' > "$payload_receipt" || return 1
    printf '[]\n' > "$canonical_receipt" || return 1
    return
  fi

  return 1
}

validate_saved_rules() {
  local receipt_prefix=$1
  local receipt="$DEPLOY_DIR/$receipt_prefix.json"
  local status_receipt="$DEPLOY_DIR/$receipt_prefix.http-status"
  local state_receipt="$DEPLOY_DIR/$receipt_prefix.state"
  local payload_receipt="$DEPLOY_DIR/$receipt_prefix.payload.json"
  local canonical_receipt="$DEPLOY_DIR/$receipt_prefix.canonical.json"
  local http_status
  local state

  IFS= read -r http_status < "$status_receipt" || return 1
  IFS= read -r state < "$state_receipt" || return 1

  case "$state" in
    present)
      test "$http_status" = 200 || return 1
      jq -e '.success == true and (.result | type == "array")' "$receipt" \
        > /dev/null || return 1
      jq -S '.result' "$receipt" | cmp - "$payload_receipt" || return 1
      jq -S '.result | map(del(.id, .last_updated))' "$receipt" \
        | cmp - "$canonical_receipt" || return 1
      ;;
    absent)
      test "$http_status" = 404 || return 1
      jq -e '
        .success == false and
        (.errors | type == "array") and
        (.errors | length == 1) and
        .errors[0].code == 10003
      ' "$receipt" > /dev/null || return 1
      printf '[]\n' | cmp - "$payload_receipt" || return 1
      printf '[]\n' | cmp - "$canonical_receipt" || return 1
      ;;
    *)
      return 1
      ;;
  esac
}

prepare_snippet_rules() {
  local saved_prefix=$1
  local body_prefix=$2
  local expected_prefix=$3
  local rule_description=$4
  local snippet_name=$5

  validate_saved_rules "$saved_prefix" || return 1
  jq --arg description "$rule_description" --arg snippet "$snippet_name" '
    {
      rules: (
        [.[] |
          select(
            .description != $description and
            (((.snippet_name // "") | startswith("legacy_redirects_260_")) | not)
          )
        ] + [{
          description: $description,
          enabled: true,
          expression: "http.host eq \"njpbs.org\"",
          snippet_name: $snippet
        }]
      )
    }
  ' "$DEPLOY_DIR/$saved_prefix.payload.json" \
    > "$DEPLOY_DIR/$body_prefix.body.json" || return 1

  jq '{success: true, result: .rules}' "$DEPLOY_DIR/$body_prefix.body.json" \
    > "$DEPLOY_DIR/$expected_prefix.json" || return 1
  printf '200\n' > "$DEPLOY_DIR/$expected_prefix.http-status" || return 1
  printf 'present\n' > "$DEPLOY_DIR/$expected_prefix.state" || return 1
  jq -S '.rules' "$DEPLOY_DIR/$body_prefix.body.json" \
    > "$DEPLOY_DIR/$expected_prefix.payload.json" || return 1
  jq -S '.rules | map(del(.id, .last_updated))' \
    "$DEPLOY_DIR/$body_prefix.body.json" \
    > "$DEPLOY_DIR/$expected_prefix.canonical.json" || return 1
}

compare_saved_rules() {
  local left_prefix=$1
  local right_prefix=$2

  validate_saved_rules "$left_prefix" || return 1
  validate_saved_rules "$right_prefix" || return 1
  cmp "$DEPLOY_DIR/$left_prefix.state" "$DEPLOY_DIR/$right_prefix.state" || return 1
  cmp "$DEPLOY_DIR/$left_prefix.canonical.json" \
    "$DEPLOY_DIR/$right_prefix.canonical.json" || return 1
}

restore_snippet_rules() {
  local saved_prefix=$1
  local response_prefix=$2
  local saved_state

  validate_saved_rules "$saved_prefix" || return 1
  IFS= read -r saved_state < "$DEPLOY_DIR/$saved_prefix.state" || return 1

  case "$saved_state" in
    absent)
      cf_api_receipt DELETE "$API_BASE/snippet_rules" "$response_prefix" || return 1
      ;;
    present)
      jq '{rules: .}' "$DEPLOY_DIR/$saved_prefix.payload.json" \
        > "$DEPLOY_DIR/$response_prefix.body.json" || return 1
      cf_api_receipt PUT "$API_BASE/snippet_rules" "$response_prefix" \
        --header 'Content-Type: application/json' \
        --data-binary "@$DEPLOY_DIR/$response_prefix.body.json" || return 1
      ;;
    *)
      return 1
      ;;
  esac

  jq -e '.success == true' "$DEPLOY_DIR/$response_prefix.json" > /dev/null || return 1
}
