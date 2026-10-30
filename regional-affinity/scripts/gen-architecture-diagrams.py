#!/usr/bin/env python3
"""Draw the sample's architecture with the official AWS Architecture Icons.

The sample gives each customer a home Region. Clients call one region-less name, a router
function redirects them (HTTP 307) to the name of the customer's home Region, and the app serves a
customer only on that name. The names sit in three levels of Amazon Route 53 records in a private
hosted zone (weighted, failover, alias), and one Amazon Application Recovery Controller (ARC) Region
switch plan drains or restores a Region at all three levels at once.

Writes architecture.svg (steady state) and architecture-drained.svg (after the plan drains
us-east-1) into the docs directory next to this script's directory. The icon artwork is embedded,
so each SVG stands alone. Open an SVG in a browser at its own size (1600 pixels wide) to get a PNG;
the README embeds docs/architecture.png and docs/architecture-drained.png.

Needs the AWS Architecture Icons package, unzipped. The checked-in diagrams were drawn with the
release of July 31, 2026. Download an icon package from https://aws.amazon.com/architecture/icons/
("Icon package"), unzip it, and regenerate with:
  python3 scripts/gen-architecture-diagrams.py --icons <unzipped package dir>
A later release may rename an icon file; if the script cannot find one, adjust ICON_FILES below.

Route 53 health checks have no icon of their own, so each one is a text label on the record edge
it controls.
"""
import argparse
import re
from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1600, 1060
SANS = "Helvetica, Arial, 'Nimbus Sans', sans-serif"
MONO = "'DejaVu Sans Mono', Menlo, Consolas, monospace"

INK, MUTED, GREY = "#232f3e", "#545b64", "#aab7b8"
GREEN, RED = "#1d8102", "#d13212"
# Group borders and labels, per the AWS architecture icon guidelines.
CLOUD, REGION, REGION_TEXT, VPC, GENERIC = "#232f3e", "#00a4a6", "#147eba", "#8c4fff", "#7d8998"
FADE = 0.35

# The names the sample deploys; lib/names.ts builds the same ones from its defaults.
PROJECT = "regional-affinity"
DOMAIN = "example.com"
REGION_LESS = f"ingest.{DOMAIN}"
HOME_NAME = {"ue1": f"ingest.ue1.{DOMAIN}", "ue2": f"ingest.ue2.{DOMAIN}"}
APP_NAME = {"ue1": f"ingest-app.ue1.{DOMAIN}", "ue2": f"ingest-app.ue2.{DOMAIN}"}
TABLE = f"{PROJECT}-customers"
ROUTER_FN, APP_FN, PROBE_FN = (f"{PROJECT}-{role}" for role in ("router", "app", "probe"))

# us-east-2 is us-east-1 flipped about the vertical line x = FLIP / 2.
FLIP = 1310
# x of the items in us-east-1's column: the router and app functions sit either side of the ALB.
ROUTER_X, APP_X, PROBE_X = 360, 440, 290
PANEL_X = 1310  # left edge of the right-hand column

ICON_FILES = {
    "route53": "Arch_Amazon-Route-53_48.svg",
    "arc": "Arch_Amazon-Application-Recovery-Controller_48.svg",
    "alb": "Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg",
    "lambda": "Res_AWS-Lambda_Lambda-Function_48.svg",
    "table": "Res_Amazon-DynamoDB_Table_48.svg",
    "peering": "Res_Amazon-VPC_Peering-Connection_48.svg",
    "zone": "Res_Amazon-Route-53-Hosted-Zone_48.svg",
    "cloud": "AWS-Cloud-logo_32.svg",
    "region": "Region_32.svg",
    "vpc": "Virtual-private-cloud-VPC_32.svg",
}
ART = {}  # icon key -> (viewBox, inner SVG markup)


def nest(key, svg):
    """The viewBox and inner markup of one icon file, ready to nest inside our SVG."""
    svg = re.sub(r"<\?xml[^>]*\?>|<title>.*?</title>", "", svg, flags=re.S)
    # Keep the ids the icon refers to (a clip path, say) under a per-icon prefix, so two icons
    # cannot collide, and drop the rest.
    refs = {url or href for url, href in re.findall(r'url\(#([^)]+)\)|href="#([^"]+)"', svg)}
    svg = re.sub(r'\sid="([^"]*)"', lambda m: f' id="{key}-{m.group(1)}"' if m.group(1) in refs else "", svg)
    for ref in refs:
        svg = svg.replace(f"url(#{ref})", f"url(#{key}-{ref})").replace(f'href="#{ref}"', f'href="#{key}-{ref}"')
    svg = re.sub(r'\s(?:version|xmlns:xlink)="[^"]*"', "", svg)
    opening = re.search(r"<svg\b[^>]*>", svg)
    view_box = re.search(r'viewBox="([^"]+)"', opening.group(0)).group(1)
    return view_box, svg[opening.end():svg.rindex("</svg>")].strip()


def load_icons(root):
    """Read each icon once."""
    for key, name in ICON_FILES.items():
        matches = sorted(p for p in root.rglob(name) if "__MACOSX" not in p.parts)
        if not matches:
            raise SystemExit(f"{name} not found under {root}: is that the unzipped icon package?")
        ART[key] = nest(key, matches[0].read_text(encoding="utf-8"))


def icon(key, cx, cy, size=48):
    view_box, inner = ART[key]
    return (f'<svg x="{cx - size / 2:g}" y="{cy - size / 2:g}" width="{size}" height="{size}" '
            f'viewBox="{view_box}">{inner}</svg>')


def text(x, y, s, size=13, weight="normal", color=INK, anchor="start", family=SANS, halo=False):
    h = ' stroke="#ffffff" stroke-width="5" stroke-linejoin="round" paint-order="stroke"' if halo else ""
    return (f'<text x="{x:g}" y="{y:g}" font-family="{family}" font-size="{size}" '
            f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}"{h}>{escape(s)}</text>')


def group(x, y, w, h, stroke, label, label_color, icon_key, dash=None):
    """An AWS group: border, its icon in the top-left corner, label beside it."""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{stroke}" '
            f'stroke-width="1.5"{d}/>'
            + icon(icon_key, x + 16, y + 16, 32)
            + text(x + 42, y + 21, label, 15, color=label_color))


def edge(points, state="on", both=False):
    """on: Route 53 answers with it or traffic flows over it. off: standby or
    drained. control: ARC setting health checks."""
    color, width, extra, head = {
        "on": (INK, 2, "", "dark"),
        "off": (GREY, 1.8, ' stroke-dasharray="7 5"', "grey"),
        "control": (INK, 1.8, ' stroke-dasharray="1 5" stroke-linecap="round"', "dark"),
    }[state]
    pts = " ".join(f"{x:g},{y:g}" for x, y in points)
    start = f' marker-start="url(#head-{head})"' if both else ""
    return (f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="{width}"{extra} '
            f'stroke-linejoin="round" marker-end="url(#head-{head})"{start}/>')


def on_if(flag):
    return "on" if flag else "off"


def check(x, y, region, healthy):
    """The ARC-managed health check on one record, named by its Region."""
    return text(x, y + 4, f"{region} {'healthy' if healthy else 'unhealthy'}", 12, "bold",
                GREEN if healthy else RED, "middle", halo=True)


def callout(cx, cy, n):
    return (f'<circle cx="{cx:g}" cy="{cy:g}" r="11" fill="{INK}" stroke="#ffffff" stroke-width="2"/>'
            + text(cx, cy + 4.5, str(n), 13, "bold", "#ffffff", "middle"))


def faded(parts, fade):
    body = "".join(parts)
    return f'<g opacity="{FADE}">{body}</g>' if fade else body


def flip(x):
    return FLIP - x


def region_contents(mirror, drained):
    """One Region below its hosted zone: ALB, probe, router and app functions, table replica.
    us-east-2 is the mirror image of us-east-1, so both inter-Region links (VPC peering at the top,
    table replication at the bottom) stay short."""

    def X(x):
        return flip(x) if mirror else x

    near, far = ("end", "start") if mirror else ("start", "end")  # label sides
    flow = on_if(not drained)
    serving = faded([
        icon("alb", X(400), 690),
        text(X(436), 686, "Internal ALB", 13, "bold", anchor=near),
        text(X(436), 702, f"{REGION_LESS}: router", 12, color=MUTED, anchor=near),
        text(X(436), 718, "every other name: app", 12, color=MUTED, anchor=near),
        icon("lambda", X(ROUTER_X), 850),
        text(X(ROUTER_X - 36), 846, "Router Lambda", 13, "bold", anchor=far),
        text(X(ROUTER_X - 36), 862, "307 to home Region name", 12, color=MUTED, anchor=far),
        text(X(ROUTER_X - 36), 878, ROUTER_FN, 12, color=MUTED, anchor=far, family=MONO),
        icon("lambda", X(APP_X), 850),
        text(X(APP_X + 36), 846, "App Lambda", 13, "bold", anchor=near),
        text(X(APP_X + 36), 862, "reads, writes items", 12, color=MUTED, anchor=near),
        text(X(APP_X + 36), 878, APP_FN, 12, color=MUTED, anchor=near, family=MONO),
    ], drained)
    return "".join([
        edge([(X(400), 714), (X(ROUTER_X), 826)], flow),
        edge([(X(400), 714), (X(APP_X), 826)], flow),
        edge([(X(ROUTER_X), 874), (X(400), 926)], flow),
        edge([(X(APP_X), 874), (X(400), 926)], flow),
        icon("lambda", X(PROBE_X), 690),
        text(X(PROBE_X), 732, "Probe Lambda", 13, "bold", anchor="middle"),
        text(X(PROBE_X), 748, "demo client", 12, color=MUTED, anchor="middle"),
        text(X(PROBE_X), 764, PROBE_FN, 12, color=MUTED, anchor="middle", family=MONO),
        serving,
        icon("table", X(400), 950),
        text(X(364), 940, "DynamoDB global table", 13, "bold", anchor=far),
        text(X(364), 956, "MREC, replica in each Region", 12, color=MUTED, anchor=far),
        text(X(364), 972, TABLE, 12, color=MUTED, anchor=far, family=MONO),
    ])


# Lines of text in the request flow. A line wrapped in backticks is set as code.
STEPS = {
    False: [
        ["The probe Lambda (demo client)", f"POSTs to {REGION_LESS} with this",
         '`{"customerId": "cust-001"}`', "JSON body. DNS returns either", "Region's ALB."],
        ["The router Lambda looks up the", "customer's home Region (here",
         "us-east-1) in its local replica", "and returns a 307 to", f"{HOME_NAME['ue1']}."],
        ["The client sends the same POST", "and body to that name. The",
         "failover record answers with its", "primary, so the us-east-1 app", "Lambda serves it."],
    ],
    True: [
        ["The probe Lambda (demo client)", f"POSTs to {REGION_LESS} with this",
         '`{"customerId": "cust-001"}`', "JSON body. Only the us-east-2", "weighted record is healthy, so",
         "DNS returns the us-east-2 ALB."],
        ["The router Lambda looks up the", "customer's home Region (here",
         "us-east-1) in its local replica", "and returns a 307 to", f"{HOME_NAME['ue1']}."],
        ["The client sends the same POST", "and body to that name. Its primary",
         "is unhealthy, so the failover", "record answers with its standby",
         "and the us-east-2 app Lambda", "serves it. The caller's URL never", "changes."],
    ],
}
# What the app checks before it serves a request, with what that means in each state.
GUARD = {
    False: ["The app serves a customer only on its", "home Region name (for cust-001,",
            f"{HOME_NAME['ue1']}). A request on any", "other name gets a 307 to that name."],
    True: ["The app serves a customer only on its", "home Region name (for cust-001,",
           f"{HOME_NAME['ue1']}). That name now", "answers with the us-east-2 ALB, so the",
           "us-east-2 app serves cust-001 there."],
}
CUSTOMERS_Y, LEGEND_Y = 676, 752  # the lower blocks of the right-hand column keep their place


def step_line(x, y, line):
    if line.startswith("`"):
        return text(x, y, line.strip("`"), 12, family=MONO)
    return text(x, y, line, 13)


def side_panel(drained):
    """The right-hand column: request flow, home Region guard, sample customers, legend."""
    s = [text(PANEL_X, 94, "Request flow", 17, "bold")]
    y = 126
    for n, lines in enumerate(STEPS[drained], 1):
        s.append(callout(PANEL_X + 11, y - 5, n))
        for line in lines:
            s.append(step_line(PANEL_X + 32, y, line))
            y += 19
        y += 14
    s.append(text(PANEL_X, y + 12, "Home Region guard", 14, "bold"))
    y += 32
    for line in GUARD[drained]:
        s.append(text(PANEL_X, y, line, 13))
        y += 18
    if y > CUSTOMERS_Y - 20:
        raise SystemExit(f"the request flow ends at y={y}, into the blocks below it")

    s += [text(PANEL_X, CUSTOMERS_Y, "Sample customers", 14, "bold"),
          text(PANEL_X, CUSTOMERS_Y + 20, "cust-001  home us-east-1", 12, family=MONO),
          text(PANEL_X, CUSTOMERS_Y + 37, "cust-002  home us-east-2", 12, family=MONO)]

    y = LEGEND_Y
    s.append(text(PANEL_X, y, "Legend", 17, "bold"))
    for i, (state, label) in enumerate((("on", "in use"), ("off", "standby, or drained by ARC"),
                                        ("control", "ARC sets health checks"))):
        row = y + 31 + 30 * i
        s += [edge([(PANEL_X, row), (PANEL_X + 56, row)], state), text(PANEL_X + 68, row + 4, label, 13)]
    s += [text(PANEL_X, y + 129, "us-east-1 healthy", 12, "bold", GREEN),
          text(PANEL_X, y + 147, "us-east-1 unhealthy", 12, "bold", RED),
          text(PANEL_X, y + 169, "Each is the Route 53 health check on", 12, color=MUTED),
          text(PANEL_X, y + 185, "that record, named by its Region.", 12, color=MUTED),
          text(PANEL_X, y + 201, "ARC creates and sets these checks.", 12, color=MUTED),
          callout(PANEL_X + 11, y + 230, 1), text(PANEL_X + 32, y + 235, "request step", 13)]
    return s


def diagram(drained):
    up = not drained  # the state of every us-east-1 health check
    title = "After ARC drains us-east-1" if drained else "Steady state: both Regions active"
    heads = "".join(
        f'<marker id="head-{n}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" '
        f'markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">'
        f'<path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
        for n, c in (("dark", INK), ("grey", GREY)))
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
         f'width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f"<title>{escape(title)}</title>",
         f"<defs>{heads}</defs>",
         f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
         text(30, 44, title, 24, "bold")]

    # Groups first: they have no fill, so nothing drawn later is hidden.
    s += [group(20, 64, 1270, 956, CLOUD, "AWS Cloud", CLOUD, "cloud"),
          group(230, 90, 850, 430, GENERIC, f"Route 53 private hosted zone: {DOMAIN}", INK,
                "zone", dash="6 4"),
          group(40, 545, 600, 460, REGION, "us-east-1 (ue1)", REGION_TEXT, "region", dash="6 4"),
          group(670, 545, 600, 460, REGION, "us-east-2 (ue2)", REGION_TEXT, "region", dash="6 4"),
          group(190, 585, 430, 205, VPC, "VPC", VPC, "vpc"),
          group(690, 585, 430, 205, VPC, "VPC", VPC, "vpc")]
    if drained:
        s.append(text(624, 566, "drained by ARC: no traffic", 13, "bold", RED, "end"))

    # ARC, which creates and flips the record health checks.
    s += [edge([(144, 186), (230, 186)], "control"),
          text(187, 160, "sets the 6", 12, color=MUTED, anchor="middle"),
          text(187, 174, "health checks", 12, color=MUTED, anchor="middle"),
          icon("arc", 120, 186),
          text(120, 230, "Application Recovery", 13, "bold", anchor="middle"),
          text(120, 246, "Controller (ARC)", 13, "bold", anchor="middle"),
          text(120, 264, "Region switch plan", 12, color=MUTED, anchor="middle"),
          text(120, 280, PROJECT, 12, color=MUTED, anchor="middle", family=MONO),
          text(120, 296, "active/active", 12, color=MUTED, anchor="middle")]

    # The three DNS levels: weighted, then failover, then alias to each ALB.
    s += [edge([(631, 150), (400, 150), (400, 262)], on_if(up)),
          edge([(679, 150), (910, 150), (910, 262)]),
          edge([(400, 310), (400, 446)], on_if(up)),          # ue1 primary
          edge([(424, 310), (886, 446)], on_if(drained)),     # ue1 standby answers once us-east-1 drains
          edge([(886, 310), (424, 446)], "off"),              # ue2 standby
          edge([(910, 310), (910, 446)]),                     # ue2 primary
          edge([(400, 494), (400, 666)], on_if(up)), text(410, 536, "alias", 12, color=MUTED),
          edge([(910, 494), (910, 666)]), text(920, 536, "alias", 12, color=MUTED)]
    s += [icon("route53", 655, 150),
          text(655, 196, REGION_LESS, 15, "bold", anchor="middle", family=MONO),
          text(655, 213, "Level 1: region-less name", 12, color=MUTED, anchor="middle"),
          text(655, 229, "weighted 50/50", 12, color=MUTED, anchor="middle"),
          icon("route53", 400, 286),
          text(436, 274, HOME_NAME["ue1"], 14, "bold", family=MONO),
          text(436, 291, "Level 2: home Region name", 12, color=MUTED),
          text(436, 306, "failover: primary ue1, standby ue2", 12, color=MUTED),
          icon("route53", 910, 286),
          text(874, 274, HOME_NAME["ue2"], 14, "bold", anchor="end", family=MONO),
          text(874, 291, "Level 2: home Region name", 12, color=MUTED, anchor="end"),
          text(874, 306, "failover: primary ue2, standby ue1", 12, color=MUTED, anchor="end"),
          faded([icon("route53", 400, 470),
                 text(436, 466, APP_NAME["ue1"], 13, "bold", family=MONO),
                 text(436, 483, "Level 3: alias to ALB", 12, color=MUTED)], drained),
          icon("route53", 910, 470),
          text(874, 466, APP_NAME["ue2"], 13, "bold", anchor="end", family=MONO),
          text(874, 483, "Level 3: alias to ALB", 12, color=MUTED, anchor="end")]
    s += [text(515, 141, "weight 50", 12, color=MUTED, anchor="middle", halo=True),
          check(515, 164, "us-east-1", up),
          text(795, 141, "weight 50", 12, color=MUTED, anchor="middle", halo=True),
          check(795, 164, "us-east-2", True),
          check(400, 378, "us-east-1", up), check(563, 351, "us-east-2", True),
          check(747, 351, "us-east-1", up), check(910, 378, "us-east-2", True)]

    # The two Regions, and the links between them.
    s += [region_contents(False, drained), region_contents(True, False),
          f'<line x1="620" y1="640" x2="690" y2="640" stroke="{INK}" stroke-width="1.8"/>',
          icon("peering", 655, 640, 44),
          text(655, 682, "VPC", 12, color=MUTED, anchor="middle", halo=True),
          text(655, 696, "peering", 12, color=MUTED, anchor="middle", halo=True),
          edge([(424, 950), (886, 950)], both=True),
          text(655, 940, "async replication", 12, color=MUTED, anchor="middle", halo=True),
          text(655, 970, "keeps running" if drained else "eventual consistency", 12, color=MUTED,
               anchor="middle", halo=True)]

    # Numbered request steps, on the parts that carry them.
    s += [callout(631, 126, 1), callout(PROBE_X - 24, 666, 1), callout(flip(PROBE_X) + 24, 666, 1),
          callout(376, 262, 3)]
    if drained:  # the us-east-2 router and app serve the request
        s += [callout(flip(ROUTER_X) + 24, 826, 2), callout(flip(APP_X) + 24, 826, 3)]
    else:
        s += [callout(ROUTER_X - 24, 826, 2), callout(APP_X - 24, 826, 3)]

    s += side_panel(drained)
    s += [text(30, 1046, "Sample setup: one Route 53 private hosted zone, associated with both VPCs and answering "
                         "only inside them; internal ALBs; 60-second TTLs.", 13, color=MUTED),
          "</svg>"]
    return "\n".join(s) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--icons", required=True, type=Path, help="unzipped AWS Architecture Icons package")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "docs",
                        help="directory for the SVGs (default: docs next to the scripts directory)")
    args = parser.parse_args()
    load_icons(args.icons)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, drained in (("architecture", False), ("architecture-drained", True)):
        path = args.out / f"{name}.svg"
        path.write_text(diagram(drained), encoding="utf-8")
        print(path)


if __name__ == "__main__":
    main()
