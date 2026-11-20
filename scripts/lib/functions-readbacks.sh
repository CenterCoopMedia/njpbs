# Source this from the pinned workflow checkout. Each caller supplies two
# functions so it can give the IAM checker only its own credential inputs.
timed_functions_readback() {
  local name="$1" started finished status=0
  shift
  started="$(date +%s%3N)"
  "$@" || status=$?
  finished="$(date +%s%3N)"
  printf 'Functions %s readback: start=%s end=%s duration=%s ms status=%s\n' \
    "$name" "$started" "$finished" "$((finished - started))" "$status"
  return "$status"
}

verify_functions_readbacks() {
  timed_functions_readback configuration "$1" &
  local config_pid=$! iam_status=0 config_status=0
  timed_functions_readback IAM "$2" || iam_status=$?
  wait "$config_pid" || config_status=$?
  if (( iam_status == 0 )); then
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      printf 'iam_verified=true\n' >> "$GITHUB_OUTPUT"
    fi
  else
    echo "::error::Event trigger IAM verification failed after deployment"
  fi
  if (( config_status != 0 )); then
    echo "::error::Deployed Functions configuration verification failed"
  fi
  (( iam_status == 0 && config_status == 0 ))
}
