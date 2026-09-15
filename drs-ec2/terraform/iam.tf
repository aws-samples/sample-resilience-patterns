# Orchestration role for the step functions. Same statements as the CDK construct and the
# CloudFormation original (proven live 2026-09-10..14); IAM is global so one role serves both regions.

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  param_base = split("/", trimprefix(local.db_param, "/"))[0]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "orchestration" {
  # DRS: start/monitor recovery, reverse replication, launch configuration, retire.
  statement {
    sid       = "Drs"
    actions   = ["drs:*"]
    resources = ["*"]
  }
  # Read-only EC2/KMS/IAM that DRS and the steps use as the caller.
  statement {
    sid = "Ec2Describe"
    actions = [
      "ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:DescribeInstanceAttribute",
      "ec2:DescribeInstanceTypes", "ec2:DescribeInstanceTypeOfferings", "ec2:DescribeAccountAttributes",
      "ec2:DescribeAvailabilityZones", "ec2:DescribeImages", "ec2:DescribeLaunchTemplates",
      "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeSecurityGroups", "ec2:DescribeSnapshots",
      "ec2:DescribeSubnets", "ec2:DescribeVolumes", "ec2:DescribeKeyPairs", "ec2:DescribeCapacityReservations",
      "ec2:DescribeHosts", "ec2:GetEbsEncryptionByDefault", "ec2:GetEbsDefaultKmsKeyId",
      "kms:DescribeKey", "kms:ListAliases", "iam:ListInstanceProfiles", "iam:ListRoles",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "TagOwnInstances"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${local.partition}:ec2:*:${local.account_id}:instance/*"]
  }
  # launch-into-source requires the target STOPPED; the step stops it directly (not via DRS), so
  # the ViaAWSService statement below does not cover it. Scoped to instances that opted in.
  statement {
    sid       = "StopLaunchIntoTarget"
    actions   = ["ec2:StopInstances"]
    resources = ["arn:${local.partition}:ec2:*:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/AWSDRS"
      values   = ["AllowLaunchingIntoThisInstance"]
    }
  }
  # DRS launches recovery instances with the CALLER's credentials (forwarded access session).
  statement {
    sid = "DrsViaServiceMutations"
    actions = [
      "ec2:CreateVolume", "ec2:DeleteVolume", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:CreateSnapshot",
      "ec2:DeleteSnapshot", "ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:StartInstances",
      "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute", "ec2:GetConsoleOutput",
      "ec2:GetConsoleScreenshot",
    ]
    resources = ["*"]
    condition {
      test     = "Bool"
      variable = "aws:ViaAWSService"
      values   = ["true"]
    }
  }
  statement {
    sid       = "DrsViaServiceRunInstances"
    actions   = ["ec2:RunInstances"]
    resources = ["*"]
    condition {
      test     = "Bool"
      variable = "aws:ViaAWSService"
      values   = ["true"]
    }
  }
  statement {
    sid     = "DrsViaServiceCreateTags"
    actions = ["ec2:CreateTags"]
    resources = [for r in ["security-group", "volume", "snapshot", "instance", "network-interface"] :
    "arn:${local.partition}:ec2:*:*:${r}/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSecurityGroup", "CreateVolume", "CreateSnapshot", "RunInstances"]
    }
    condition {
      test     = "Bool"
      variable = "aws:ViaAWSService"
      values   = ["true"]
    }
  }
  statement {
    sid       = "DrsLaunchTemplateMaintenance"
    actions   = ["ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplateVersions"]
    resources = ["arn:${local.partition}:ec2:*:*:launch-template/*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/AWSElasticDisasterRecoveryManaged"
      values   = ["false"]
    }
  }
  statement {
    sid     = "PassRolesForRecoveryLaunch"
    actions = ["iam:PassRole"]
    resources = [
      var.app_instance_role_arn,
      "arn:${local.partition}:iam::${local.account_id}:role/service-role/AWSElasticDisasterRecoveryConversionServerRole",
      "arn:${local.partition}:iam::${local.account_id}:role/service-role/AWSElasticDisasterRecoveryRecoveryInstanceRole",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
  statement {
    sid = "Elb"
    actions = ["elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets",
    "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "SsmDbEndpoint"
    actions   = ["ssm:PutParameter", "ssm:GetParameter"]
    resources = ["arn:${local.partition}:ssm:*:${local.account_id}:parameter/${local.param_base}/*"]
  }
}

resource "aws_iam_role" "orchestration" {
  provider           = aws.primary
  name_prefix        = "${var.project}-drs-steps-"
  description        = "${var.project}: DRS Region Switch step functions"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "basic" {
  provider   = aws.primary
  role       = aws_iam_role.orchestration.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "orchestration" {
  provider = aws.primary
  role     = aws_iam_role.orchestration.id
  name     = "orchestration"
  policy   = data.aws_iam_policy_document.orchestration.json
}

# What the PLAN's execution role needs to run these steps; attach to your aws_arcregionswitch_plan role.
data "aws_iam_policy_document" "plan_role" {
  statement {
    sid       = "InvokeDrsRegionSwitchSteps"
    actions   = ["lambda:InvokeFunction", "lambda:GetFunction"]
    resources = concat(values(module.primary.function_arns), values(module.secondary.function_arns))
  }
}
