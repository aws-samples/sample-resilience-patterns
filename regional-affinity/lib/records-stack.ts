import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { RecordNames } from './names';

/** recordName -> Region -> ARC health check ID, as `scripts/demo.py health-checks` prints it. */
export type HealthCheckIds = Record<string, Record<string, string>>;

export interface RecordsStackProps extends cdk.StackProps {
  readonly names: RecordNames;
  readonly regions: readonly [string, string];
  readonly hostedZoneId: string;
  /** Region -> the ALB's DNS name and canonical hosted zone ID. */
  readonly albs: Record<string, { readonly dnsName: string; readonly hostedZoneId: string }>;
  readonly healthChecks: HealthCheckIds;
  /**
   * Whether the app-name aliases follow the ALB's target health. The sample's ALBs send requests
   * to Lambda functions with target health checks off (the default for Lambda targets), so their
   * target health carries no information, and false leaves the ARC health checks as the only
   * signal. With ALBs in front of real targets use true, so a Region whose targets are all
   * unhealthy stops answering before ARC acts.
   */
  readonly albEvaluateTargetHealth?: boolean;
}

const HEALTH_CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The three levels of records, created bottom-up:
 *
 *   app names       alias each Region's ALB; never move between Regions, so no ARC check
 *   regional names  fail over between the two app names (PRIMARY: own Region, SECONDARY: other)
 *   region-less     weighted 50/50 across the two regional names
 *
 * Every record that sends traffic to a Region carries the ARC health check vended for that record
 * name and that Region, and its SetIdentifier is that Region. A SECONDARY points at the other
 * Region's app name, never at the other regional name, so the two failover pairs cannot form an
 * alias loop. Both checks are healthy at rest, so a SECONDARY is inactive only because its PRIMARY
 * wins.
 */
export class RecordsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RecordsStackProps) {
    super(scope, id, props);
    const { names, regions, hostedZoneId } = props;
    const [first, second] = regions;
    const other = (region: string) => (region === first ? second : first);

    const check = (recordName: string, region: string): string => {
      const id = props.healthChecks[recordName]?.[region];
      if (!id || !HEALTH_CHECK_ID.test(id)) {
        throw new Error(`no ARC health check ID for ${recordName} in ${region} (got "${id ?? ''}"); `
          + 'run `make health-checks` after the plan stack is deployed');
      }
      return id;
    };
    const alias = (dnsName: string, zoneId: string, evaluateTargetHealth: boolean) => ({
      dnsName, hostedZoneId: zoneId, evaluateTargetHealth,
    });

    const appRecords = new route53.CfnRecordSetGroup(this, 'AppRecords', {
      hostedZoneId,
      recordSets: regions.map((region) => ({
        name: names.app[region],
        type: 'A',
        aliasTarget: alias(props.albs[region].dnsName, props.albs[region].hostedZoneId, props.albEvaluateTargetHealth ?? false),
      })),
    });

    const regionalRecords = new route53.CfnRecordSetGroup(this, 'RegionalRecords', {
      hostedZoneId,
      recordSets: regions.flatMap((home) => [
        {
          name: names.regional[home], type: 'A', failover: 'PRIMARY', setIdentifier: home,
          healthCheckId: check(names.regional[home], home),
          aliasTarget: alias(names.app[home], hostedZoneId, true),
        },
        {
          name: names.regional[home], type: 'A', failover: 'SECONDARY', setIdentifier: other(home),
          healthCheckId: check(names.regional[home], other(home)),
          aliasTarget: alias(names.app[other(home)], hostedZoneId, true),
        },
      ]),
    });
    // An alias to a name in the same zone needs that name to exist first.
    regionalRecords.addResourceDependency(appRecords);

    // Route 53 leaves out a weighted record whose ARC check is unhealthy, so draining a Region
    // sends all of the region-less name's answers to the other one.
    const regionLessRecords = new route53.CfnRecordSetGroup(this, 'RegionLessRecords', {
      hostedZoneId,
      recordSets: regions.map((region) => ({
        name: names.regionLess, type: 'A', weight: 50, setIdentifier: region,
        healthCheckId: check(names.regionLess, region),
        aliasTarget: alias(names.regional[region], hostedZoneId, true),
      })),
    });
    regionLessRecords.addResourceDependency(regionalRecords);
  }
}
