#!/usr/bin/env python3
"""Render docs/architecture/architecture.png from the official AWS Architecture Icons.

Usage (from the eks-multi-region directory; needs graphviz `dot` on PATH):

    uv run --with diagrams==0.25.1 --with resvg-py python3 docs/architecture/render.py

The icons come from the AWS Architecture Icons package published at
https://aws.amazon.com/architecture/icons/ (release 2026-07-31, pinned below). The zip is
downloaded to a cache directory, the handful of SVGs the diagram uses are rasterized to
256 px PNGs with resvg, and `diagrams` (graphviz) lays the picture out. Nothing here talks
to an AWS account. Re-run after any topology change and commit the PNG alongside the code.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
import tempfile
import urllib.request
import zipfile

import resvg_py
from diagrams import Cluster, Diagram, Edge
from diagrams.custom import Custom

ICON_PACKAGE_URL = (
    "https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/"
    "architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip"
)
ARCH = "Architecture-Service-Icons_07312026"
RES = "Resource-Icons_07312026"
ICONS = {
    "user": f"{RES}/Res_General-Icons/Res_48_Light/Res_User_48_Light.svg",
    "bastion": f"{RES}/Res_Compute/Res_Amazon-EC2_Instance_48.svg",
    "nodes": f"{RES}/Res_Compute/Res_Amazon-EC2_Instances_48.svg",
    "endpoints": f"{RES}/Res_Networking-Content-Delivery/Res_Amazon-VPC_Endpoints_48.svg",
    "alb": f"{RES}/Res_Networking-Content-Delivery/"
           "Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg",
    "nlb": f"{RES}/Res_Networking-Content-Delivery/"
           "Res_Elastic-Load-Balancing_Network-Load-Balancer_48.svg",
    "eks": f"{ARCH}/Arch_Containers/64/Arch_Amazon-Elastic-Kubernetes-Service_64.svg",
    "fargate": f"{ARCH}/Arch_Containers/64/Arch_AWS-Fargate_64.svg",
    "lambda": f"{ARCH}/Arch_Compute/64/Arch_AWS-Lambda_64.svg",
    "aurora": f"{ARCH}/Arch_Databases/64/Arch_Amazon-Aurora_64.svg",
    "route53": f"{ARCH}/Arch_Networking-Content-Delivery/64/Arch_Amazon-Route-53_64.svg",
    "arc": f"{ARCH}/Arch_Networking-Content-Delivery/64/"
           "Arch_Amazon-Application-Recovery-Controller_64.svg",
    "cloudwatch": f"{ARCH}/Arch_Management-Tools/64/Arch_Amazon-CloudWatch_64.svg",
    "fis": f"{ARCH}/Arch_Developer-Tools/64/Arch_AWS-Fault-Injection-Service_64.svg",
}

HERE = pathlib.Path(__file__).resolve().parent

# AWS architecture-diagram palette: red = control/recovery, green = traffic, blue = data,
# purple = network, grey = telemetry and dependencies.
RED, GREEN, BLUE, PURPLE, GREY = "#DD344C", "#7AA116", "#1A73E8", "#8C4FFF", "#879196"


def rasterize_icons(package: pathlib.Path, out_dir: pathlib.Path,
                    size: int = 256) -> dict[str, str]:
    """Extract the SVGs listed in ICONS from the zip and write them as PNGs; name -> path."""
    out_dir = out_dir.resolve()  # graphviz resolves `image` relative to its own cwd; be explicit
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    with zipfile.ZipFile(package) as zf:
        for name, member in ICONS.items():
            png = out_dir / f"{name}.png"
            if not png.exists():
                svg = zf.read(member).decode("utf-8")
                png_bytes = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
                png.write_bytes(bytes(png_bytes))
            paths[name] = str(png)
    return paths


def fetch_package(cache_dir: pathlib.Path) -> pathlib.Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / ICON_PACKAGE_URL.rsplit("/", 1)[1]
    if not target.exists():
        print(f"downloading {ICON_PACKAGE_URL}", file=sys.stderr)
        urllib.request.urlretrieve(ICON_PACKAGE_URL, target)  # noqa: S310 (fixed https URL)
    return target


def render(icon: dict[str, str], out_stem: str) -> None:
    graph_attr = {
        "fontsize": "14", "fontname": "Helvetica", "bgcolor": "white", "pad": "0.4",
        "nodesep": "0.7", "ranksep": "0.9", "splines": "ortho", "dpi": "120",
        # xlabels are dropped when they would overlap unless forced; the replication edge
        # relies on one (see the Aurora edge below).
        "forcelabels": "true",
    }
    node_attr = {"fontsize": "11", "fontname": "Helvetica", "width": "1.5", "height": "1.15"}
    edge_attr = {"fontsize": "10", "fontname": "Helvetica", "color": "#545B64"}
    region_attr = {"bgcolor": "#F7F9FB", "pencolor": PURPLE, "style": "rounded", "fontsize": "14"}
    vpc_attr = {"bgcolor": "#FFFFFF", "pencolor": BLUE, "style": "rounded,dashed", "fontsize": "12"}
    global_attr = {"bgcolor": "#FFF8F8", "pencolor": RED, "style": "rounded", "fontsize": "14"}
    loose = {"constraint": "false"}  # draw the edge, but do not let it push nodes down a rank

    with Diagram("", filename=out_stem, show=False, direction="TB", outformat="png",
                 graph_attr=graph_attr, node_attr=node_attr, edge_attr=edge_attr):
        operator = Custom("Operator\nAWS CLI + Session Manager plugin", icon["user"])

        with Cluster("Global", graph_attr=global_attr):
            arc = Custom("ARC Region switch plan\nscale standby EKS, switch Aurora\n"
                         "writer, flip health checks", icon["arc"])
            r53 = Custom("Route 53 private hosted zone\nfailover records", icon["route53"])
            cw = Custom("CloudWatch\nmetrics, logs and alarms\nfrom all three regions",
                        icon["cloudwatch"])

        with Cluster("us-east-1 (observer)", graph_attr=region_attr):
            with Cluster("Observer VPC: no IGW, no NAT", graph_attr=vpc_attr):
                bastion = Custom("Bastion (t4g.nano)\nno public IP, no inbound", icon["bastion"])
                loadgen = Custom("Locust on Fargate\n10 users, 24x7", icon["fargate"])
                obs_ep = Custom("Interface endpoints\nSSM, ECR, Logs\n+ S3 gateway",
                                icon["endpoints"])

        def workload_region(name: str, role: str, primary: bool):
            with Cluster(f"{name} ({role})", graph_attr=region_attr):
                with Cluster("Workload VPC: 3 AZs, isolated subnets, no NAT",
                             graph_attr=vpc_attr):
                    alb = Custom("Internal ALB\nArgo CD UI" + ("" if primary else " + cockpit"),
                                 icon["alb"])
                    nlb = Custom("NLB\norders-api", icon["nlb"])
                    extra = {}
                    eks = Custom("EKS 1.36\norders-api (one pod per AZ)\nArgo CD, Karpenter",
                                 icon["eks"])
                    if not primary:
                        extra["cockpit"] = Custom("Cockpit\nLambda", icon["lambda"])
                    # Creation order steers graphviz's left-to-right placement: the two
                    # Aurora clusters face each other across the region boundary so the
                    # replication edge is short, and FIS sits beside the nodes it targets.
                    # FIS is a PRIMARY-region service here: every experiment template lives
                    # in us-east-2 and targets that region's nodes; the cockpit in the standby
                    # starts them across the region boundary.
                    aurora_label = ("Aurora Serverless v2\n"
                                    + ("writer + 2 readers" if primary else "secondary, 3 readers"))
                    if primary:
                        endpoints = Custom("13 interface\nendpoints", icon["endpoints"])
                        extra["fis"] = Custom("FIS experiments\nnetem, AZ blackhole", icon["fis"])
                        nodes = Custom("Graviton nodes\nnode group + Karpenter", icon["nodes"])
                        aurora = Custom(aurora_label, icon["aurora"])
                    else:
                        aurora = Custom(aurora_label, icon["aurora"])
                        nodes = Custom("Graviton nodes\nnode group + Karpenter", icon["nodes"])
                        endpoints = Custom("13 interface\nendpoints", icon["endpoints"])
                alb >> Edge(color=GREEN) >> eks
                nlb >> Edge(color=GREEN) >> eks
                eks >> Edge(label="reads: regional\nreader endpoint", color=BLUE) >> aurora
                eks >> Edge(style="dotted", color=GREY) >> nodes
                eks >> Edge(style="dotted", color=GREY,
                            label="AWS APIs\nvia endpoints") >> endpoints
                if primary:
                    extra["fis"] >> Edge(color=RED, style="dashed", label="SSM", **loose) >> nodes
                else:
                    alb >> Edge(color=GREEN, label="/cockpit") >> extra["cockpit"]
                return alb, nlb, eks, aurora, nodes, extra

        alb_e, nlb_e, eks_e, aurora_e, nodes_e, x_e = workload_region("us-east-2", "primary", True)
        alb_w, nlb_w, eks_w, aurora_w, nodes_w, x_w = workload_region("us-west-2", "standby", False)

        # The cockpit runs in the standby (it must survive a primary impairment) and starts
        # experiments in the primary region's FIS.
        x_w["cockpit"] >> Edge(color=RED, label="StartExperiment\n(primary-region FIS)",
                               **loose) >> x_e["fis"]

        # Operator path: Session Manager port-forward to the bastion, then VPC peering.
        operator >> Edge(label="SSM Session Manager\nport-forward (IAM only)", color=RED) >> bastion
        bastion >> Edge(style="dotted", color=GREY, **loose) >> obs_ep
        loadgen >> Edge(style="dotted", color=GREY, label="image pull,\nEMF logs", **loose) >> obs_ep
        bastion >> Edge(label="VPC peering", color=PURPLE) >> alb_e
        bastion >> Edge(label="VPC peering", color=PURPLE) >> alb_w

        # Traffic follows the failover record; ARC flips the health checks behind it. ARC's
        # other two steps (scale the standby EKS, switch the Aurora global writer) are named
        # in its label rather than drawn: two more region-crossing edges made the picture
        # unreadable, and the README text carries the sequence.
        arc >> Edge(label="health checks", color=RED) >> r53
        r53 >> Edge(label="active", color=GREEN) >> nlb_e
        r53 >> Edge(label="standby", style="dashed", color=GREEN) >> nlb_w
        # The client lives in the observer VPC: it resolves the record and its requests cross
        # the observer's own peering into whichever region the record currently answers with.
        loadgen >> Edge(xlabel="resolves the\nfailover record", color=GREEN, **loose) >> r53
        loadgen >> Edge(label="requests over\nVPC peering", color=GREEN) >> nlb_e
        loadgen >> Edge(style="dashed", color=GREEN) >> nlb_w

        # Data: every write goes to the Aurora Global writer endpoint, wherever it is.
        eks_e >> Edge(label="writes", color=BLUE) >> aurora_e
        eks_w >> Edge(label="writes: global writer endpoint\nover VPC peering", style="dashed",
                      color=BLUE, **loose) >> aurora_e
        # xlabel, not label: with orthogonal splines graphviz places a plain label for this
        # long, constraint-free edge nowhere near it (it landed among the primary EKS edges).
        # An external label is positioned after layout, at the edge's midpoint.
        aurora_e >> Edge(xlabel="Aurora Global Database\nreplication", color=BLUE,
                         **loose) >> aurora_w

        # Telemetry from every region lands in CloudWatch; said in the node label, not drawn.


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--out", default=str(HERE / "architecture.png"), help="output PNG path")
    ap.add_argument("--cache", default=os.environ.get("TMPDIR", tempfile.gettempdir()),
                    help="where to cache the icon package and rasterized icons")
    args = ap.parse_args()
    cache = pathlib.Path(args.cache).resolve() / "aws-architecture-icons"
    icons = rasterize_icons(fetch_package(cache), cache / "png")
    out = pathlib.Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    render(icons, str(out.with_suffix("")))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
