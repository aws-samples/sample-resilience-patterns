# Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  http://aws.amazon.com/asl/

import json
import boto3
import os
import urllib3

HTTP = urllib3.PoolManager()


def lambda_handler(event, context):
    """
    CloudFormation custom resource handler that adds/removes routes in a
    peer VPC's route tables to enable VPC peering connectivity.

    Environment variables:
      - vpc_id: The peer VPC ID to add routes to
      - peer_region: The region of the peer VPC
      - peering_connection_id: The VPC peering connection ID
      - destination_cidr: The CIDR block to route via the peering connection
    """
    vpc_id = os.environ["vpc_id"]
    peer_region = os.environ["peer_region"]
    peering_connection_id = os.environ["peering_connection_id"]
    destination_cidr = os.environ["destination_cidr"]
    response_url = event.get("ResponseURL")

    client = boto3.client("ec2", region_name=peer_region)
    print(json.dumps(event, default=str))

    try:
        # Get non-main route table IDs for the peer VPC
        route_table_ids = get_route_table_ids(client, vpc_id)
        print(f"Found {len(route_table_ids)} route tables: {route_table_ids}")

        if event["RequestType"] == "Create":
            for rt_id in route_table_ids:
                try:
                    client.create_route(
                        DestinationCidrBlock=destination_cidr,
                        RouteTableId=rt_id,
                        VpcPeeringConnectionId=peering_connection_id,
                    )
                    print(f"Added route to {rt_id}")
                except client.exceptions.ClientError as e:
                    if "RouteAlreadyExists" in str(e):
                        print(f"Route already exists in {rt_id}, skipping")
                    else:
                        raise

        elif event["RequestType"] == "Delete":
            for rt_id in route_table_ids:
                try:
                    client.delete_route(
                        DestinationCidrBlock=destination_cidr,
                        RouteTableId=rt_id,
                    )
                    print(f"Deleted route from {rt_id}")
                except client.exceptions.ClientError as e:
                    if "InvalidRoute.NotFound" in str(e):
                        print(f"Route not found in {rt_id}, skipping")
                    else:
                        raise

        # Update is a no-op — routes are idempotent
        send_cfn_response(response_url, event, context, True)

    except Exception as e:
        print(f"Error: {e}")
        send_cfn_response(response_url, event, context, False)


def get_route_table_ids(client, vpc_id):
    """Returns non-main route table IDs for the given VPC."""
    route_tables = client.describe_route_tables(
        Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
    )["RouteTables"]

    ids = []
    for rt in route_tables:
        # Skip the main route table
        is_main = any(
            assoc.get("Main", False) for assoc in rt.get("Associations", [])
        )
        if not is_main:
            ids.append(rt["RouteTableId"])
    return ids


def send_cfn_response(response_url, event, context, success, data={}):
    if not response_url:
        return

    status = "SUCCESS" if success else "FAILED"
    response_data = {
        "StackId": event.get("StackId"),
        "RequestId": event.get("RequestId"),
        "LogicalResourceId": event.get("LogicalResourceId", ""),
        "PhysicalResourceId": event.get(
            "PhysicalResourceId",
            f"{context.function_name}-{context.function_version}",
        ),
        "Status": status,
        "Data": data,
    }
    body = json.dumps(response_data)
    headers = {"content-type": "", "content-length": str(len(body))}
    try:
        response = HTTP.request("PUT", response_url, headers=headers, body=body)
        print(f"CloudFormation returned status code: {response.reason}")
    except Exception as e:
        print(f"Failed to send CFN response: {e}")
        raise
