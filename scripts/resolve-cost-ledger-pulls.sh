#!/usr/bin/env bash

set -euo pipefail

secret_version_ready() {
  local secret_name="$1"
  local state
  state="$(timeout 10s gcloud secrets versions describe latest \
    --secret="$secret_name" \
    --project njpbs-site \
    --format='value(state)' 2>/dev/null)" || return 1
  [[ "$state" == ENABLED ]]
}

safe_gcp_project=""
safe_gcp_billing_table=""
safe_cloudflare_account_id=""
safe_github_account=""
safe_github_account_type=""
if [[ "${COST_LEDGER_GCP_PROJECT:-}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  safe_gcp_project="$COST_LEDGER_GCP_PROJECT"
fi
if [[ "${COST_LEDGER_GCP_BILLING_TABLE:-}" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  safe_gcp_billing_table="$COST_LEDGER_GCP_BILLING_TABLE"
fi
if [[ "${COST_LEDGER_CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[a-f0-9]{32}$ ]]; then
  safe_cloudflare_account_id="$COST_LEDGER_CLOUDFLARE_ACCOUNT_ID"
fi
if [[ "${COST_LEDGER_GITHUB_ACCOUNT:-}" =~ ^[A-Za-z0-9-]+$ ]]; then
  safe_github_account="$COST_LEDGER_GITHUB_ACCOUNT"
fi
if [[ "${COST_LEDGER_GITHUB_ACCOUNT_TYPE:-}" =~ ^(user|org)$ ]]; then
  safe_github_account_type="$COST_LEDGER_GITHUB_ACCOUNT_TYPE"
fi

effective_gcp_pull=false
effective_cloudflare_pull=false
effective_aws_pull=false
effective_github_pull=false
if [[ "${COST_LEDGER_GCP_PULL:-false}" == true ]]; then
  if [[ -n "$safe_gcp_project" && -n "$safe_gcp_billing_table" ]] \
    && secret_version_ready COST_LEDGER_GCP_BILLING_SA; then
    effective_gcp_pull=true
  else
    echo "GCP cost pull remains disabled because its configuration or secret version is absent." >&2
  fi
fi
if [[ "${COST_LEDGER_CLOUDFLARE_PULL:-false}" == true ]]; then
  if [[ -n "$safe_cloudflare_account_id" ]] \
    && secret_version_ready COST_LEDGER_CLOUDFLARE_API_TOKEN; then
    effective_cloudflare_pull=true
  else
    echo "Cloudflare cost pull remains disabled because its configuration or secret version is absent." >&2
  fi
fi
if [[ "${COST_LEDGER_AWS_PULL:-false}" == true ]]; then
  if secret_version_ready COST_LEDGER_AWS_ACCESS_KEY_ID \
    && secret_version_ready COST_LEDGER_AWS_SECRET_ACCESS_KEY; then
    effective_aws_pull=true
  else
    echo "AWS cost pull remains disabled because its secret version is absent." >&2
  fi
fi
if [[ "${COST_LEDGER_GITHUB_PULL:-false}" == true ]]; then
  if [[ -n "$safe_github_account" && -n "$safe_github_account_type" ]] \
    && secret_version_ready COST_LEDGER_GITHUB_TOKEN; then
    effective_github_pull=true
  else
    echo "GitHub cost pull remains disabled because its configuration or secret version is absent." >&2
  fi
fi

# Ship the same decision to discovery and runtime; no credential payloads.
cat > functions/cost-ledger-pulls.generated.json <<EOF
{
  "COST_LEDGER_GCP_PULL": $effective_gcp_pull,
  "COST_LEDGER_CLOUDFLARE_PULL": $effective_cloudflare_pull,
  "COST_LEDGER_AWS_PULL": $effective_aws_pull,
  "COST_LEDGER_GITHUB_PULL": $effective_github_pull
}
EOF

printf 'COST_LEDGER_GCP_PULL=%s\n' "$effective_gcp_pull"
printf 'COST_LEDGER_CLOUDFLARE_PULL=%s\n' "$effective_cloudflare_pull"
printf 'COST_LEDGER_AWS_PULL=%s\n' "$effective_aws_pull"
printf 'COST_LEDGER_GITHUB_PULL=%s\n' "$effective_github_pull"
printf 'COST_LEDGER_GCP_PROJECT=%s\n' "$safe_gcp_project"
printf 'COST_LEDGER_GCP_BILLING_TABLE=%s\n' "$safe_gcp_billing_table"
printf 'COST_LEDGER_CLOUDFLARE_ACCOUNT_ID=%s\n' "$safe_cloudflare_account_id"
printf 'COST_LEDGER_GITHUB_ACCOUNT=%s\n' "$safe_github_account"
printf 'COST_LEDGER_GITHUB_ACCOUNT_TYPE=%s\n' "$safe_github_account_type"
