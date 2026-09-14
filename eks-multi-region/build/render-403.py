#!/usr/bin/env python3
"""Render the CFS 403 bounce page (step 12).

Substitutes the two tokens the vendored template carries — the CloudFrontSigner
service endpoint (a constant: the PROD /sign endpoint, matching the trusted-signer
account the FrontDoorStack pins) and the authorizer Bindle id, which is PER-DEPLOYER
(runbook prerequisite 8: every deployer onboards their own distribution at CFS and
grants access on their own Bindle).

FAIL-CLOSED BY DESIGN. If CFS_BINDLE_ID is unset, a sentinel is substituted and a
loud warning printed — the deploy still succeeds, but CFS refuses to onboard a
nonexistent Bindle, so the distribution stays unreachable to EVERYONE rather than
open to anyone. The worst case of skipping the config is an unreachable site,
never an exposed one; that property comes from CloudFront's own signed-cookie
enforcement (TrustedSigners on the default behavior), which is active from the
moment the distribution deploys and is not something this page turns on.

The template is vendored BYTE-FAITHFUL from CloudFrontSignerConstructs
(resources/cfsigner403.html); this script refuses to render a copy whose tokens
have drifted, because a template missing its token would silently render a page
that redirects nowhere.

Usage: render-403.py <template> > 403.html   (CFS_BINDLE_ID from the environment)
"""
import os
import sys

# The PROD /sign endpoint. Must stay paired with CFS_TRUSTED_SIGNER_ACCOUNT in
# front-door-stack.ts — the endpoint mints cookies with the key pair of THAT
# account, so mixing prod endpoint with gamma signer (or vice versa) yields
# cookies CloudFront rejects, indistinguishable from a failed onboarding.
CFS_SERVICE_ENDPOINT = "https://cloudfrontsigner.ninjas.security.a2z.com/sign"

ENDPOINT_TOKEN = "INSERT-SERVICE-ENDPOINT-HERE"
BINDLE_TOKEN = "INSERT-BINDLE-ID-HERE"
SENTINEL = "amzn1.bindle.UNSET-SEE-RUNBOOK-PREREQUISITE-8"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: render-403.py <template>", file=sys.stderr)
        return 2
    text = open(sys.argv[1], encoding="utf-8").read()

    for token in (ENDPOINT_TOKEN, BINDLE_TOKEN):
        if text.count(token) != 1:
            print(
                f"ERROR: template does not contain exactly one {token} — "
                "vendored 403.html has drifted from the CFS contract.",
                file=sys.stderr,
            )
            return 1

    bindle = os.environ.get("CFS_BINDLE_ID", "").strip()
    if not bindle:
        print(
            "WARNING: CFS_BINDLE_ID is unset. Rendering with a sentinel Bindle id: "
            "CFS onboarding will refuse it and the front door stays LOCKED for "
            "everyone (fail-closed). Set the CFS_BINDLE_ID CI variable and redeploy "
            "— see runbook prerequisite 8.",
            file=sys.stderr,
        )
        bindle = SENTINEL

    sys.stdout.write(
        text.replace(ENDPOINT_TOKEN, CFS_SERVICE_ENDPOINT).replace(BINDLE_TOKEN, bindle)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
