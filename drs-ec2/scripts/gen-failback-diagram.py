#!/usr/bin/env python3
"""Render the stateful-EC2 fail-back (DRS reverse replication) as an AWS-icon PNG.

Companion to gen-architecture-diagram.py, same visual language. Orientation is deliberately
mirrored: the secondary (currently serving) is on the LEFT and the primary on the RIGHT, so the
diagram reads left-to-right as "data and traffic come home". Shows the RETURN leg for an
EC2 that carries local state: starting from the post-failover picture (traffic + writer in
us-west-2, recovered EC2 serving), the six ARC fail-back steps bring the data and the workload
home and re-establish protection.

Run:  uvx --from diagrams python scripts/gen-failback-diagram.py
Output: docs/failback-stateful.png
"""
import os

from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import EC2
from diagrams.aws.database import AuroraInstance
from diagrams.aws.network import ELB, Route53, Route53HostedZone
from diagrams.aws.storage import EBS

OUT = os.path.join(os.path.dirname(__file__), os.pardir, "docs", "failback-stateful")

graph_attr = {
    "fontsize": "18", "labelloc": "t", "pad": "0.5", "splines": "polyline",
    "nodesep": "1.6", "ranksep": "0.9", "newrank": "true", "forcelabels": "true",
}
GREEN = {"color": "darkgreen", "fontcolor": "darkgreen", "penwidth": "1.8"}
RED = {"color": "firebrick", "fontcolor": "firebrick", "penwidth": "1.8",
       "labelfontcolor": "firebrick", "labelfontsize": "16", "labeldistance": "1.6"}
DASH = {"style": "dashed", "color": "gray40", "fontcolor": "gray30"}
CLUSTER = {"labelloc": "b", "labeljust": "c", "fontsize": "14", "margin": "24"}

with Diagram(
    "drs-ec2 — stateful EC2 fail-back (ARC activate us-east-2), read left → right\n"
    "① reverse-replicate recovered EC2 to primary   ② launch for failback   ③ register target\n"
    "④ Aurora switch back   ⑤ DNS flip back   ⑥ re-protect: replicate failed-back EC2 to secondary",
    filename=OUT, outformat="png", show=False, direction="TB", graph_attr=graph_attr,
):
    dns = Route53("Route 53 private zone\napp.drsdemo.internal\nfailover record pair")
    arc = Route53HostedZone("ARC Region Switch plan\nfail-back workflow (6 steps)")

    # ---- primary column: being rebuilt from the secondary's data ----
    with Cluster("us-east-2 (primary) — receiving fail-back", graph_attr=CLUSTER):
        alb_e = ELB("ALB")
        fb_src = EBS("FAILBACK source server\n(new; disks copied home)")
        ec2_fb = EC2("failed-back EC2\n(launched from ②)")
        aur_e = AuroraInstance("Aurora Global\nreader → writer")
        alb_e >> Edge(**DASH) >> ec2_fb >> Edge(**DASH) >> aur_e
        alb_e >> Edge(style="invis") >> fb_src   # pin beside the failed-back EC2

    # ---- secondary column: currently serving ----
    with Cluster("us-west-2 (secondary) — serving since failover", graph_attr=CLUSTER):
        alb_w = ELB("ALB")
        ec2_w = EC2("recovered EC2\n(carrying local state)")
        stage_w = EBS("DRS staging\n(original source server, reused)")
        aur_w = AuroraInstance("Aurora Global\nwriter → reader")
        alb_w >> ec2_w >> Edge(xlabel="reads / writes") >> aur_w
        alb_w >> Edge(style="invis") >> stage_w
        ec2_w >> Edge(style="invis", constraint="false") >> stage_w   # keep staging on the inner side

    # ---- DNS at start of fail-back: secondary healthy ----
    dns >> Edge(xlabel="hc A", **DASH) >> alb_e
    dns >> Edge(xlabel="hc B", color="gray30") >> alb_w

    # ---- data coming home (right -> left) ----
    ec2_w >> Edge(xlabel="① reversed block\nreplication",
                  constraint="false", **GREEN) >> fb_src
    aur_w >> Edge(xlabel="④ Aurora Global switchover-back", constraint="false", **GREEN) >> aur_e

    # ⑥ re-protect: the original source server is re-pointed at the failed-back EC2
    ec2_fb >> Edge(constraint="false", style="dashed", tailport="s", headport="s", **GREEN) >> stage_w

    # ---- the six ARC steps, numbered at the arrowheads ----
    arc >> Edge(headlabel="③", **RED) >> alb_e     # register into primary target group
    arc >> Edge(headlabel="②", **RED) >> fb_src    # StartRecovery from the FAILBACK server
    arc >> Edge(headlabel="⑥", **RED) >> ec2_fb    # ReverseReplication on the failed-back instance
    arc >> Edge(headlabel="④", **RED) >> aur_e     # Aurora switchover-back
    arc >> Edge(headlabel="①", **RED) >> ec2_w     # ReverseReplication on the recovery instance
    arc >> Edge(headlabel="⑤", constraint="false", **RED) >> dns   # DNS flip-back

print(f"wrote {OUT}.png")
