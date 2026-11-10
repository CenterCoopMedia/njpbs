```bash
set -euo pipefail
for bucket in njpbs-video-originals-123456789012-us-east-2 njpbs-archive-originals-123456789012-us-east-2; do
  tiering_config_count="$(aws --profile njpbs-admin --region us-east-2 s3api list-bucket-intelligent-tiering-configurations \
    --bucket "$bucket" --expected-bucket-owner 123456789012 \
    --query 'length(IntelligentTieringConfigurationList || `[]`)' --output json)"
  if [ "$tiering_config_count" != "0" ]; then
    printf '%s\n' "Stop: reconcile Intelligent-Tiering configurations for $bucket before any lifecycle write." >&2
    exit 1
  fi
done
for source in video archive; do
  bucket="njpbs-${source}-originals-123456789012-us-east-2"
  aws --profile njpbs-admin --region us-east-2 s3api put-bucket-lifecycle-configuration \
    --bucket "$bucket" --expected-bucket-owner 123456789012 \
    --transition-default-minimum-object-size all_storage_classes_128K \
    --lifecycle-configuration "file://infrastructure/boardwalk-s3/lifecycle/${source}-originals.json"
  aws --profile njpbs-admin --region us-east-2 s3api get-bucket-lifecycle-configuration \
    --bucket "$bucket" --expected-bucket-owner 123456789012
done
aws --profile njpbs-admin --region us-east-2 s3api put-bucket-lifecycle-configuration \
  --bucket njpbs-video-renditions-123456789012-us-east-2 --expected-bucket-owner 123456789012 \
  --transition-default-minimum-object-size all_storage_classes_128K \
  --lifecycle-configuration file://infrastructure/boardwalk-s3/lifecycle/renditions.json
aws --profile njpbs-admin --region us-east-2 s3api get-bucket-lifecycle-configuration \
  --bucket njpbs-video-renditions-123456789012-us-east-2 --expected-bucket-owner 123456789012
```
