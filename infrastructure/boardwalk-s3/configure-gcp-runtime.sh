#!/usr/bin/env bash
set -euo pipefail

project_id="njpbs-site"
project_number="${GCP_PROJECT_NUMBER:?Set the Google project number}"
service_account_id="boardwalk-s3-media"
service_account_email="${service_account_id}@${project_id}.iam.gserviceaccount.com"
deployer="firebase-adminsdk-fbsvc@${project_id}.iam.gserviceaccount.com"
run_service_agent="service-${project_number}@serverless-robot-prod.iam.gserviceaccount.com"

if [[ "${1:-}" != "--apply" ]]; then
  cat <<EOF
Planned Google runtime identity:
  project: ${project_id} (${project_number})
  service account: ${service_account_email}
  project roles: roles/datastore.user, roles/firebaseauth.viewer
  deployer can attach: ${deployer}
  Cloud Run service agent can mint tokens: ${run_service_agent}

Run this reviewed artifact with --apply through an authorized Google Cloud identity.
EOF
  exit 0
fi

active_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "${active_project}" != "${project_id}" ]]; then
  echo "Active gcloud project must be ${project_id}." >&2
  exit 1
fi

actual_project_number="$(gcloud projects describe "${project_id}" --format='value(projectNumber)')"
if [[ "${actual_project_number}" != "${project_number}" ]]; then
  echo "Google project number did not match the reviewed value." >&2
  exit 1
fi

if ! gcloud iam service-accounts describe "${service_account_email}" \
  --project "${project_id}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${service_account_id}" \
    --project "${project_id}" \
    --display-name "Boardwalk S3 media runtime" \
    --description "Keyless runtime identity for Boardwalk access to approved NJ PBS S3 sources"
fi

for role in roles/datastore.user roles/firebaseauth.viewer; do
  gcloud projects add-iam-policy-binding "${project_id}" \
    --member "serviceAccount:${service_account_email}" \
    --role "${role}" \
    --condition None \
    --quiet >/dev/null
done

gcloud iam service-accounts add-iam-policy-binding "${service_account_email}" \
  --project "${project_id}" \
  --member "serviceAccount:${run_service_agent}" \
  --role roles/iam.serviceAccountTokenCreator \
  --condition None \
  --quiet >/dev/null

gcloud iam service-accounts describe "${service_account_email}" \
  --project "${project_id}" \
  --format='json(email,uniqueId,oauth2ClientId,disabled)'
