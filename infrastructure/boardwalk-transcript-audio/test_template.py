"""Policy and default-off checks for transcript audio infrastructure."""

from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[2]
AUDIO_TEMPLATE = ROOT / "infrastructure" / "boardwalk-transcript-audio" / "template-v1.json"
PREVIEW_TEMPLATE = ROOT / "infrastructure" / "boardwalk-video-previews" / "template-v1.json"
BYOK_TEMPLATE = ROOT / "infrastructure" / "boardwalk-transcription-byok" / "template-v1.json"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TemplateTest(unittest.TestCase):
    def test_deployment_account_guard_requires_explicit_configuration(self):
        for path in (AUDIO_TEMPLATE, PREVIEW_TEMPLATE):
            template = load(path)
            parameter = template["Parameters"]["DeploymentAccountId"]
            self.assertNotIn("Default", parameter)
            self.assertEqual(parameter["AllowedPattern"], "^[0-9]{12}$")
            assertions = template["Rules"]["TargetAccountAndRegion"]["Assertions"]
            self.assertIn(
                {"Fn::Equals": [{"Ref": "AWS::AccountId"}, {"Ref": "DeploymentAccountId"}]},
                [assertion["Assert"] for assertion in assertions],
            )

    def test_empty_image_creates_only_private_repository(self):
        template = load(AUDIO_TEMPLATE)
        self.assertEqual(template["Parameters"]["ImageUri"]["Default"], "")
        self.assertEqual(template["Parameters"]["FfmpegArtifactSha256"]["Default"], "")
        unconditional = {
            name: resource["Type"]
            for name, resource in template["Resources"].items()
            if "Condition" not in resource
        }
        self.assertEqual(unconditional, {"TranscriptAudioRepository": "AWS::ECR::Repository"})
        self.assertEqual(
            {resource.get("Condition") for resource in template["Resources"].values() if resource["Type"] != "AWS::ECR::Repository"},
            {"HasImage"},
        )
        self.assertFalse(
            any(resource["Type"] == "AWS::Lambda::Permission" for resource in template["Resources"].values())
        )
        repository_policy = template["Resources"]["TranscriptAudioRepository"]["Properties"]["RepositoryPolicyText"]
        self.assertEqual(repository_policy["Statement"][0]["Principal"], {"Service": "lambda.amazonaws.com"})
        self.assertIn("${AWS::StackName}-worker", json.dumps(repository_policy))

    def test_worker_has_no_paid_provider_or_original_media_permission(self):
        template = load(AUDIO_TEMPLATE)
        statements = template["Resources"]["TranscriptAudioRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        actions = {
            action
            for statement in statements
            for action in (statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]])
        }
        self.assertTrue(actions <= {
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:ListBucket",
            "s3:ListBucketVersions",
            "s3:PutObject",
            "s3:DeleteObjectVersion",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "sqs:SendMessage",
        })
        resources = json.dumps(statements)
        self.assertIn("/outputs/*", resources)
        self.assertIn("/transcripts/inputs/audio/*", resources)
        list_statement = next(statement for statement in statements if statement["Sid"] == "ListExactInputsAndReceipts")
        self.assertEqual(
            list_statement["Condition"]["StringLike"]["s3:prefix"],
            ["outputs/*", "transcripts/inputs/audio/*"],
        )
        self.assertNotIn("original", resources.lower())
        self.assertNotIn("transcribe:", resources)

    def test_invocation_is_conditional_and_exact_in_both_calling_roles(self):
        for path, role in ((PREVIEW_TEMPLATE, "TranscriptControlRole"), (BYOK_TEMPLATE, "RunnerDataRole")):
            template = load(path)
            parameter = template["Parameters"]["TranscriptAudioPreparationFunctionArn"]
            self.assertEqual(parameter["Default"], "")
            policy = template["Resources"]["TranscriptAudioPreparationInvokePolicy"]
            self.assertEqual(policy["Condition"], "HasTranscriptAudioPreparationFunction")
            self.assertEqual(policy["Properties"]["Roles"], [{"Ref": role}])
            bucket_parameter = "RenditionBucketName" if role == "TranscriptControlRole" else "RenditionBucket"
            bucket_arn = "arn:${AWS::Partition}:s3:::${" + bucket_parameter + "}"
            conditions = {
                "StringEquals": {
                    "s3:ResourceAccount": {"Ref": "AWS::AccountId"},
                    "aws:RequestedRegion": {"Ref": "AWS::Region"},
                },
                "Bool": {"aws:SecureTransport": "true"},
            }
            self.assertEqual(policy["Properties"]["PolicyDocument"]["Statement"], [
                {
                    "Sid": "InvokeExactAudioPreparationFunction",
                    "Effect": "Allow",
                    "Action": "lambda:InvokeFunction",
                    "Resource": {"Ref": "TranscriptAudioPreparationFunctionArn"},
                },
                {
                    "Sid": "ReadSharedAudioAndReceipts",
                    "Effect": "Allow",
                    "Action": ["s3:GetObject", "s3:GetObjectVersion"],
                    "Resource": {"Fn::Sub": bucket_arn + "/transcripts/inputs/audio/*"},
                    "Condition": conditions,
                },
                {
                    "Sid": "DeleteExactSharedAudioVersion",
                    "Effect": "Allow",
                    "Action": "s3:DeleteObjectVersion",
                    "Resource": {"Fn::Sub": bucket_arn + "/transcripts/inputs/audio/*/attempts/*/input.m4a"},
                    "Condition": conditions,
                },
                {
                    "Sid": "DeleteExactAmazonAudioCopy",
                    "Effect": "Allow",
                    "Action": "s3:DeleteObjectVersion",
                    "Resource": {"Fn::Sub": bucket_arn + "/transcripts/inputs/amazon/*/attempts/*/input.m4a"},
                    "Condition": conditions,
                },
            ])

    def test_async_work_is_bounded_and_failed_events_expire(self):
        template = load(AUDIO_TEMPLATE)
        function = template["Resources"]["TranscriptAudioFunction"]["Properties"]
        invoke = template["Resources"]["TranscriptAudioAsyncPolicy"]["Properties"]
        queue = template["Resources"]["TranscriptAudioFailureQueue"]["Properties"]
        self.assertEqual(function["Timeout"], 900)
        self.assertEqual(function["ReservedConcurrentExecutions"], 1)
        self.assertEqual(function["EphemeralStorage"]["Size"], 4096)
        self.assertEqual(invoke["MaximumEventAgeInSeconds"], 900)
        self.assertEqual(invoke["MaximumRetryAttempts"], 0)
        self.assertEqual(queue["MessageRetentionPeriod"], 1_209_600)


if __name__ == "__main__":
    unittest.main()
