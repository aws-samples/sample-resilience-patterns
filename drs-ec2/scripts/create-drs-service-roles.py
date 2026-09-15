#!/usr/bin/env python3
"""Create the six DRS service roles required by drs initialize-service.

Recipe is straight from
https://docs.aws.amazon.com/drs/latest/userguide/getting-started-initializing.html
(role names, /service-role/ path, trusted entities, managed-policy pairings)
plus the source-identity trust conditions from the AWS re:Post agent-install
troubleshooting article for the two drs.amazonaws.com-trust roles.

Idempotent: skips roles/profiles that already exist.
"""
import json
import sys

import boto3
from botocore.exceptions import ClientError

ACCOUNT = sys.argv[1] if len(sys.argv) > 1 else None
if not ACCOUNT:
    sys.exit("usage: create_drs_service_roles.py <account-id>")

iam = boto3.client("iam")

EC2_TRUST = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"Service": "ec2.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }
    ],
}

def drs_trust(account: str) -> dict:
    # Source identity + source account are required per the DRS docs' note
    # ("the trust policy needs to define source identity and source account
    # for security reasons") -- this is confused-deputy protection.
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "drs.amazonaws.com"},
                "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"],
                "Condition": {
                    "StringLike": {
                        "sts:SourceIdentity": "s-*",
                        "aws:SourceAccount": account,
                    }
                },
            }
        ],
    }

MP = "arn:aws:iam::aws:policy/service-role/"
SSM = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

# (role, trust, [managed policy arns], needs_instance_profile)
ROLES = [
    ("AWSElasticDisasterRecoveryAgentRole", "drs",
     [MP + "AWSElasticDisasterRecoveryAgentPolicy"], False),
    ("AWSElasticDisasterRecoveryFailbackRole", "drs",
     [MP + "AWSElasticDisasterRecoveryFailbackPolicy"], False),
    ("AWSElasticDisasterRecoveryConversionServerRole", "ec2",
     [MP + "AWSElasticDisasterRecoveryConversionServerPolicy"], True),
    ("AWSElasticDisasterRecoveryRecoveryInstanceRole", "ec2",
     [MP + "AWSElasticDisasterRecoveryRecoveryInstancePolicy"], True),
    ("AWSElasticDisasterRecoveryReplicationServerRole", "ec2",
     [MP + "AWSElasticDisasterRecoveryReplicationServerPolicy"], True),
    ("AWSElasticDisasterRecoveryRecoveryInstanceWithLaunchActionsRole", "ec2",
     [MP + "AWSElasticDisasterRecoveryRecoveryInstancePolicy", SSM], True),
]


def main() -> int:
    failures = []
    for name, trust_kind, policies, needs_profile in ROLES:
        trust = EC2_TRUST if trust_kind == "ec2" else drs_trust(ACCOUNT)
        try:
            iam.create_role(
                Path="/service-role/",
                RoleName=name,
                AssumeRolePolicyDocument=json.dumps(trust),
                Description="Created for AWS Elastic Disaster Recovery service initialization.",
            )
            print(f"created role   {name}")
        except ClientError as e:
            if e.response["Error"]["Code"] == "EntityAlreadyExists":
                print(f"exists  role   {name}")
            else:
                failures.append((name, "create_role", e)); print(f"FAILED role   {name}: {e}"); continue

        for arn in policies:
            try:
                iam.attach_role_policy(RoleName=name, PolicyArn=arn)
                print(f"  attached     {arn.rsplit('/', 1)[-1]}")
            except ClientError as e:
                failures.append((name, arn, e)); print(f"  FAILED attach {arn}: {e}")

        if needs_profile:
            try:
                iam.create_instance_profile(
                    Path="/service-role/", InstanceProfileName=name
                )
                print(f"  created instance profile {name}")
            except ClientError as e:
                if e.response["Error"]["Code"] == "EntityAlreadyExists":
                    print(f"  exists instance profile {name}")
                else:
                    failures.append((name, "create_instance_profile", e))
                    print(f"  FAILED instance profile: {e}")
            try:
                iam.add_role_to_instance_profile(
                    InstanceProfileName=name, RoleName=name
                )
                print("  role added to instance profile")
            except ClientError as e:
                if e.response["Error"]["Code"] == "LimitExceeded":
                    print("  role already in instance profile")
                else:
                    failures.append((name, "add_role_to_instance_profile", e))
                    print(f"  FAILED add to profile: {e}")

    print()
    if failures:
        print(f"{len(failures)} failure(s):")
        for name, what, err in failures:
            print(f"  {name} / {what}: {err}")
        return 1
    print("all six roles present with policies and instance profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
