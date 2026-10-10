data "aws_iam_policy_document" "invoke" {
  statement {
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-fixture-v2",
      "arn:aws:bedrock:*:${data.aws_caller_identity.me.account_id}:inference-profile/eu.anthropic.claude-fixture-opus-9",
    ]
  }
}
