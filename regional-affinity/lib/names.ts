/**
 * Names shared by every stack, and by scripts/demo.py, which derives the same names from the
 * same inputs (test/names.test.ts compares the two).
 *
 * With the defaults (app label `ingest`, domain `example.com`, Regions us-east-1 and us-east-2):
 *
 *   ingest.example.com          region-less name, weighted 50/50 across the two regional names
 *   ingest.ue1.example.com      regional name: failover, us-east-1 primary, us-east-2 standby
 *   ingest.ue2.example.com      regional name: failover, us-east-2 primary, us-east-1 standby
 *   ingest-app.ue1.example.com  app name: alias to the internal ALB in us-east-1
 *   ingest-app.ue2.example.com  app name: alias to the internal ALB in us-east-2
 */

/** The VPC CIDR of the first and second Region. They must not overlap: the VPCs are peered. */
export const VPC_CIDRS = ['10.11.0.0/16', '10.12.0.0/16'] as const;

/**
 * The tag bin/app.ts puts on every stack. cleanup.sh deletes a stack only when it carries this tag,
 * so a PROJECT prefix that matches another application's stack names cannot delete that application.
 * Stacks deployed before the tag existed get it on their next deploy.
 */
export const SAMPLE_TAG = { key: 'sample', value: 'regional-affinity' } as const;

/**
 * The label a Region gets in its regional name: the first letter of each word, then the number.
 * us-east-1 -> ue1, us-west-2 -> uw2, eu-central-1 -> ec1.
 */
export function regionLabel(region: string): string {
  const parts = region.split('-');
  const last = parts[parts.length - 1];
  if (parts.length < 3 || !/^\d+$/.test(last) || parts.some((p) => !/^[a-z0-9]+$/.test(p))) {
    throw new Error(`"${region}" is not an AWS Region name such as us-east-1`);
  }
  return parts.slice(0, -1).map((p) => p[0]).join('') + last;
}

export interface RecordNames {
  /** The name clients call first, in no particular Region. */
  readonly regionLess: string;
  /** Region -> the regional name whose primary is that Region (a customer's home Region name). */
  readonly regional: Record<string, string>;
  /** Region -> the app name, an alias to that Region's ALB. */
  readonly app: Record<string, string>;
}

export function recordNames(appLabel: string, domain: string, regions: readonly string[]): RecordNames {
  const regional: Record<string, string> = {};
  const app: Record<string, string> = {};
  for (const region of regions) {
    regional[region] = `${appLabel}.${regionLabel(region)}.${domain}`;
    app[region] = `${appLabel}-app.${regionLabel(region)}.${domain}`;
  }
  return { regionLess: `${appLabel}.${domain}`, regional, app };
}

/** The two Regions, from a comma-separated list; they must be distinct and get distinct labels. */
export function parseRegions(value: string): [string, string] {
  const regions = value.split(',').map((r) => r.trim()).filter(Boolean);
  if (regions.length !== 2) {
    throw new Error(`regions must name exactly two Regions, such as us-east-1,us-east-2 (got "${value}")`);
  }
  const [a, b] = regions;
  if (a === b || regionLabel(a) === regionLabel(b)) {
    throw new Error(`regions ${a} and ${b} need different labels (${regionLabel(a)}, ${regionLabel(b)})`);
  }
  return [a, b];
}

/**
 * Prefixes every stack and named resource. At most 24 characters, so that the longest name built
 * from it (`<project>-router`, a Lambda function and log group) stays readable in the console.
 * It is also the plan's name, and Region switch rejects a plan name that ends in a hyphen: that
 * would fail the `plan` step after the earlier stacks are already deployed.
 */
export function checkProject(project: string): string {
  if (!/^[a-z][a-z0-9-]{0,22}[a-z0-9]$/.test(project)) {
    throw new Error(`project "${project}" must be 2 to 24 lowercase letters, digits and hyphens, `
      + 'starting with a letter and ending with a letter or digit');
  }
  return project;
}

export function checkLabel(appLabel: string): string {
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(appLabel)) {
    throw new Error(`appLabel "${appLabel}" must be 1 to 20 lowercase letters, digits and hyphens, starting with a letter`);
  }
  return appLabel;
}

export function checkDomain(domain: string): string {
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error(`domain "${domain}" is not a lowercase DNS name such as example.com`);
  }
  return domain;
}
