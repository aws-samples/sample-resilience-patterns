"""CloudFormation custom resource: cross-region VPC peering configurator.

Generalized (vendored) from the predecessor project-app:
    src/lambda/peering-configurator/peering_configurator.py

Creates + accepts + routes for every unique pair in a set of
{region, vpc_id, cidr, route_table_ids} descriptors (full mesh = N·(N-1)/2
connections).

Event shape (passed as ResourceProperties by the PeeringMesh construct):

  {
    "ManagedTag": { "Key": "CreDemo", "Value": "managed" },
    "Peers": [
      {
        "Role": "",            # optional, free-form; requester-preference only
        "Region": "us-east-1",
        "VpcId": "vpc-...",
        "VpcCidr": "10.0.0.0/16",
        "RouteTableIds": ["rtb-...", "rtb-..."]
      },
      ...
    ]
  }

On Create / Update: creates every unique peering pair, accepts in the peer
region, adds routes in every supplied route table (both directions).

On Delete: deletes peerings tagged with the managed tag (routes auto-clean).

Idempotent: tags every peering with the managed tag (default CreDemo=managed)
so re-runs discover existing connections instead of duplicating.

Generalizations vs the the predecessor project version (networking-changeset §2.4, §5):
  - The managed tag is configurable: read from ResourceProperties.ManagedTag,
    defaulting to {"Key": "CreDemo", "Value": "managed"} (was the module
    constants FiveNinesDemo=managed).
  - The peer Role is optional / free-form; it only affects which peer is the
    requester in a pair (cosmetic). An empty role falls through to array order.
  - The stale Route 53 PHZ docstring is dropped — no PHZ exists in this design.

Pure stdlib + boto3 + urllib3. Python 3.12.
"""

from __future__ import annotations

import json
import os
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
import urllib3

HTTP = urllib3.PoolManager()

DEFAULT_MANAGED_TAG = {"Key": "CreDemo", "Value": "managed"}


# ---------------------------------------------------------------------------
# CloudFormation response helper
# ---------------------------------------------------------------------------

def _send(response_url: str, event: Dict[str, Any], context: Any,
          status: str, reason: str = "OK", data: Optional[Dict[str, Any]] = None) -> None:
    physical_id = event.get("PhysicalResourceId") \
        or f"{context.function_name}-{event.get('LogicalResourceId', '')}"
    body = json.dumps({
        "Status": status,
        "Reason": reason,
        "StackId": event.get("StackId"),
        "RequestId": event.get("RequestId"),
        "LogicalResourceId": event.get("LogicalResourceId", ""),
        "PhysicalResourceId": physical_id,
        "Data": data or {},
    })
    try:
        HTTP.request(
            "PUT", response_url,
            headers={"content-type": "", "content-length": str(len(body))},
            body=body,
        )
    except Exception as exc:  # noqa: BLE001 — we want any failure logged
        print(f"Failed to send CFN response: {exc}")
        raise


# ---------------------------------------------------------------------------
# Managed tag (configurable; default CreDemo=managed)
# ---------------------------------------------------------------------------

def _managed_tag(props: Dict[str, Any]) -> Tuple[str, str]:
    """Return (key, value) for the managed tag from ResourceProperties.ManagedTag."""
    tag = props.get("ManagedTag") or DEFAULT_MANAGED_TAG
    return tag.get("Key", DEFAULT_MANAGED_TAG["Key"]), tag.get("Value", DEFAULT_MANAGED_TAG["Value"])


# ---------------------------------------------------------------------------
# Core peering logic
# ---------------------------------------------------------------------------

def _ec2(region: str):
    return boto3.client("ec2", region_name=region)


def _find_existing_peering(src_peer: Dict[str, Any], dst_peer: Dict[str, Any]) -> Optional[str]:
    """Return the peering connection ID if one already exists between the two VPCs."""
    ec2 = _ec2(src_peer["Region"])
    resp = ec2.describe_vpc_peering_connections(Filters=[
        {"Name": "requester-vpc-info.vpc-id", "Values": [src_peer["VpcId"]]},
        {"Name": "accepter-vpc-info.vpc-id", "Values": [dst_peer["VpcId"]]},
        {"Name": "status-code", "Values": ["pending-acceptance", "active", "provisioning"]},
    ]).get("VpcPeeringConnections", [])
    return resp[0]["VpcPeeringConnectionId"] if resp else None


def _create_peering(src: Dict[str, Any], dst: Dict[str, Any],
                    tag_key: str, tag_value: str) -> str:
    """Create a peering connection from src→dst, tag it, and accept in dst's region."""
    existing = _find_existing_peering(src, dst)
    if existing:
        print(f"Peering {src['Region']}→{dst['Region']} already exists: {existing}")
        return existing

    requester = _ec2(src["Region"])
    resp = requester.create_vpc_peering_connection(
        VpcId=src["VpcId"],
        PeerVpcId=dst["VpcId"],
        PeerRegion=dst["Region"],
        TagSpecifications=[{
            "ResourceType": "vpc-peering-connection",
            "Tags": [
                {"Key": tag_key, "Value": tag_value},
                {"Key": "Name", "Value": f"{src['Region']}-{dst['Region']}"},
            ],
        }],
    )
    peering_id = resp["VpcPeeringConnection"]["VpcPeeringConnectionId"]
    print(f"Requested peering {src['Region']}→{dst['Region']}: {peering_id}")

    # Accept in the peer region (peering may take a moment to become visible)
    accepter = _ec2(dst["Region"])
    waiter = accepter.get_waiter("vpc_peering_connection_exists")
    waiter.wait(VpcPeeringConnectionIds=[peering_id], WaiterConfig={"Delay": 5, "MaxAttempts": 24})
    accepter.accept_vpc_peering_connection(VpcPeeringConnectionId=peering_id)
    # Also tag on the accepter side for easier discovery / cleanup.
    accepter.create_tags(
        Resources=[peering_id],
        Tags=[{"Key": tag_key, "Value": tag_value}],
    )
    print(f"Accepted peering {peering_id} in {dst['Region']}")
    return peering_id


def _add_routes(region: str, route_table_ids: Iterable[str],
                destination_cidr: str, peering_id: str) -> None:
    """Add a route per route table (safe to re-run — ignores duplicates)."""
    ec2 = _ec2(region)
    for rtb in route_table_ids:
        try:
            ec2.create_route(
                RouteTableId=rtb,
                DestinationCidrBlock=destination_cidr,
                VpcPeeringConnectionId=peering_id,
            )
            print(f"Route added: {rtb} {destination_cidr} → {peering_id}")
        except ec2.exceptions.ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code == "RouteAlreadyExists":
                print(f"Route exists: {rtb} {destination_cidr}")
            else:
                raise


def _unique_pairs(peers: List[Dict[str, Any]]) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
    """All unique unordered pairs (full mesh).

    A peer whose free-form Role is "Client" is preferred as the requester (tidier;
    client-initiated peerings). With empty/any role this falls through to array
    order — correct for the generic N-region case.
    """
    pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    for i in range(len(peers)):
        for j in range(i + 1, len(peers)):
            a, b = peers[i], peers[j]
            if a.get("Role") == "Client":
                pairs.append((a, b))
            elif b.get("Role") == "Client":
                pairs.append((b, a))
            else:
                pairs.append((a, b))
    return pairs


def _create_or_update(peers: List[Dict[str, Any]], tag_key: str, tag_value: str) -> Dict[str, str]:
    """Create all peerings + routes. Returns {label: peeringId}."""
    peering_ids: Dict[str, str] = {}

    for src, dst in _unique_pairs(peers):
        pid = _create_peering(src, dst, tag_key, tag_value)
        peering_ids[f"{src['Region']}-{dst['Region']}"] = pid

        # Routes on both sides
        _add_routes(src["Region"], src["RouteTableIds"], dst["VpcCidr"], pid)
        _add_routes(dst["Region"], dst["RouteTableIds"], src["VpcCidr"], pid)

    return peering_ids


def _delete_all(peers: List[Dict[str, Any]], tag_key: str, tag_value: str) -> None:
    """Tear down managed peerings. Filter by managed tag so we don't touch anything else."""
    for src, dst in _unique_pairs(peers):
        ec2 = _ec2(src["Region"])
        resp = ec2.describe_vpc_peering_connections(Filters=[
            {"Name": "requester-vpc-info.vpc-id", "Values": [src["VpcId"]]},
            {"Name": "accepter-vpc-info.vpc-id", "Values": [dst["VpcId"]]},
            {"Name": f"tag:{tag_key}", "Values": [tag_value]},
        ]).get("VpcPeeringConnections", [])

        for peering in resp:
            pid = peering["VpcPeeringConnectionId"]
            try:
                ec2.delete_vpc_peering_connection(VpcPeeringConnectionId=pid)
                print(f"Deleted peering {pid} ({src['Region']}→{dst['Region']})")
            except Exception as exc:  # noqa: BLE001
                print(f"Peering delete skipped ({pid}): {exc}")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def lambda_handler(event: Dict[str, Any], context: Any) -> None:
    print(f"Event: {json.dumps(event)}")
    response_url = event["ResponseURL"]
    request_type = event["RequestType"]
    props = event.get("ResourceProperties", {})
    peers = props.get("Peers", [])
    tag_key, tag_value = _managed_tag(props)

    try:
        if request_type in ("Create", "Update"):
            peering_ids = _create_or_update(peers, tag_key, tag_value)
            _send(response_url, event, context, "SUCCESS", data=peering_ids)
        elif request_type == "Delete":
            _delete_all(peers, tag_key, tag_value)
            _send(response_url, event, context, "SUCCESS")
        else:
            _send(response_url, event, context, "FAILED",
                  reason=f"Unknown RequestType: {request_type}")
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc())
        _send(response_url, event, context, "FAILED", reason=str(exc))


# Trivial accessor for tests
def _sentinel() -> str:
    return os.environ.get("SENTINEL", "")
