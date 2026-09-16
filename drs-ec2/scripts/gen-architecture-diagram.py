#!/usr/bin/env python3
"""Render the drs-ec2 architecture as an AWS-icon PNG using the `diagrams` library.

Run:  uvx --from diagrams python scripts/gen-architecture-diagram.py
(Graphviz `dot` must be on PATH; on AL2023: sudo dnf install -y graphviz)

Output: docs/architecture.png

Layout: top-to-bottom, orthogonal edges. Control plane (Route 53 + ARC plan) across the top;
the two regions as side-by-side columns (ALB -> EC2 -> Aurora); replication as short
horizontal edges between the columns. The ARC node lists its four steps; the red edges carry
only the step number at the arrowhead, so nothing long has to be placed along a long edge.
"""
import os

from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import EC2
from diagrams.aws.database import AuroraInstance
from diagrams.aws.network import ELB, Route53, Route53HostedZone
from diagrams.aws.storage import EBS
from diagrams.aws.management import SystemsManager
from diagrams.onprem.client import User

OUT = os.path.join(os.path.dirname(__file__), os.pardir, "docs", "architecture")

graph_attr = {
    "fontsize": "18", "labelloc": "t", "pad": "0.9", "splines": "polyline",
    "nodesep": "1.6", "ranksep": "0.9", "newrank": "true", "forcelabels": "true",
}
GREEN = {"color": "darkgreen", "fontcolor": "darkgreen", "penwidth": "1.8"}
RED = {"color": "firebrick", "fontcolor": "firebrick", "penwidth": "1.8",
       "labelfontcolor": "firebrick", "labelfontsize": "16", "labeldistance": "1.6"}
DASH = {"style": "dashed", "color": "gray40", "fontcolor": "gray30"}
CLUSTER = {"labelloc": "b", "labeljust": "c", "fontsize": "14", "margin": "24"}

with Diagram(
    "drs-ec2 — DRS + ARC Region Switch\n"
    "ARC plan steps (red):  ① Aurora Global switch   ② DRS recover EC2   ③ register target   ④ DNS flip",
    filename=OUT, outformat="png", show=False, direction="TB", graph_attr=graph_attr,
):
    # ---- observer: a third region standing in for the customer's user ----
    OBS = dict(CLUSTER, labelloc="t")
    with Cluster("us-east-1 (observer) — no public IP, SSM only", graph_attr=OBS):
        user = User("presenter\nlocalhost:8080/ui")
        bastion = SystemsManager("bastion t3.nano\nresolves the failover record")
        user >> Edge(label="SSM port-forward", constraint="false") >> bastion

    # ---- control plane, top row ----
    dns = Route53("Route 53 private zone\napp.drsdemo.internal\nfailover record pair")
    # This diagrams release has no dedicated Application Recovery Controller icon; ARC Region
    # Switch drives Route 53 health-check state, so the Route 53 ARC family icon is the fit.
    arc = Route53HostedZone("ARC Region Switch plan\n(--mode graceful | ungraceful)")

    # ---- primary column ----
    with Cluster("us-east-2 (primary) — serving at rest", graph_attr=CLUSTER):
        alb_e = ELB("internal ALB")
        ec2_e = EC2("EC2 (Flask)\n+ DRS agent")
        aur_e = AuroraInstance("Aurora Global\nwriter")
        alb_e >> ec2_e >> Edge(xlabel="reads / writes") >> aur_e

    # ---- secondary column ----
    with Cluster("us-west-2 (secondary) — populated at failover", graph_attr=CLUSTER):
        alb_w = ELB("internal ALB\n(target group empty at rest)")
        stage = EBS("DRS staging")
        ec2_w = EC2("recovered EC2")
        aur_w = AuroraInstance("Aurora Global\nreader → writer")
        alb_w >> Edge(**DASH) >> ec2_w >> Edge(**DASH) >> aur_w
        alb_w >> Edge(style="invis") >> stage  # pin staging beside the recovered EC2

    # observer resolves the failover record via the private zone and reaches whichever
    # (internal) ALB is healthy over VPC peering
    bastion >> Edge(color="gray30", taillabel="peering", labelfontcolor="gray30", labelfontsize="11") >> alb_e
    bastion >> Edge(**DASH) >> alb_w

    # ---- DNS: healthy record wins ----
    dns >> Edge(xlabel="hc A", color="gray30", tailport="s", headport="n") >> alb_e
    dns >> Edge(xlabel="hc B", tailport="s", headport="n", **DASH) >> alb_w

    # ---- replication, horizontal between the columns ----
    ec2_e >> Edge(xlabel="DRS block\nreplication", constraint="false", **GREEN) >> stage
    aur_e >> Edge(xlabel="Aurora Global replication", constraint="false", **GREEN) >> aur_w

    # ---- ARC steps: numbers at the arrowheads, full names on the ARC node ----
    arc >> Edge(headlabel="①", tailport="s", headport="e", **RED) >> aur_w
    arc >> Edge(headlabel="②", tailport="s", headport="e", **RED) >> ec2_w
    arc >> Edge(headlabel="③", tailport="s", headport="e", **RED) >> alb_w
    arc >> Edge(headlabel="④", constraint="false", tailport="s", headport="s", **RED) >> dns

print(f"wrote {OUT}.png")
