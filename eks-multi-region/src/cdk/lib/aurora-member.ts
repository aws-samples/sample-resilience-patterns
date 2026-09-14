// Adapted from aws-samples/sample-resilience-patterns@9091f42 (MIT-0):
// aurora/lib/database-stack.ts (primary) and aurora/lib/database-replica-stack.ts
// (secondary). Translated, not vendored.
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

/**
 * Aurora PostgreSQL engine version for EVERY member of the global cluster.
 *
 * PINNED, and the pin is load-bearing. The source repo pins `VER_16_6`, which RDS
 * RETIRED in July 2026. `VER_16_6` is still present in the CDK enum, so a stack pinning
 * it compiles, synthesizes and passes every local gate — and is then rejected by RDS at
 * deploy time. The CDK enum is not a statement about service availability.
 *
 * Declared once here so the primary and the secondary cannot drift: a global cluster
 * whose members disagree on engine version will not form.
 */
export const AURORA_ENGINE_VERSION = rds.AuroraPostgresEngineVersion.VER_16_8;

/**
 * Aurora Serverless v2 capacity range, identical on every member.
 *
 * LIVE-SIZED, not guessed. The provisioned `db.r6g.large` this replaced ran at 13-15%
 * CPU of 2 vCPU with 8-13 database connections under the demo's steady load
 * (measured 2026-09-04), i.e. well under one ACU of actual compute. `db.r6g.large` is
 * 16 GiB ≈ 8 ACU-equivalent, so THREE serverless instances holding ~2 ACU each cost
 * less always-on compute than the single provisioned instance they replace.
 *
 * The floor is 2 rather than the 0.5 minimum on purpose, and it is a DEMO-FIDELITY
 * choice rather than a performance one: `shared_buffers` and `max_connections` both
 * derive from ACU, so a floor that scales up under load would add its own latency
 * variance on top of an injected fault — and every FIS severity number in
 * docs/runbook.md was calibrated against a fixed-size instance. A floor the workload
 * never leaves keeps those numbers meaning what they measured.
 *
 * The ceiling is a COST STOP, not a capacity plan: 16 ACU is 2x the instance class it
 * replaces, so a runaway cannot quietly cost more than a few provisioned instances.
 *
 * Both values apply to the SECONDARY member too, via the same construct. That is a
 * requirement, not a convenience: a secondary whose ceiling is below the primary's
 * cannot keep up with replication.
 */
export const AURORA_MIN_ACU = 2;
export const AURORA_MAX_ACU = 16;

/**
 * AZ index of each cluster member, and the whole point of this construct's shape.
 *
 * PROVEN NECESSARY ON 2026-09-04. The cluster was a SINGLE instance in us-east-2b, and
 * the AZ power-interruption fault's `aws:network:disrupt-connectivity` action blackholes
 * the faulted zone's subnets — which are the SAME subnets as the Aurora DB subnet group.
 * Faulting us-east-2b therefore cut the region's only database out from under all three
 * AZs: regional availability read 0.00%, FIS's own 50% guardrail halted the experiment
 * three minutes in, and a "single-AZ" fault was in fact region-wide one time in three.
 * Whether the demo's core claim held was decided by which zone happened to be busiest.
 *
 * Pinning is deliberate rather than left to Aurora's automatic placement, because
 * automatic placement is what produced the gamble: with the AZ unpinned, nothing in the
 * template says the members occupy different zones, and nothing fails when they don't.
 *
 * Index 1 for the writer is not arbitrary either — it is where the live writer already
 * sits in BOTH regions (us-east-2b, us-west-2b, verified 2026-09-04), so adopting this
 * pin does not move an existing writer. `AvailabilityZone` on `AWS::RDS::DBInstance` is
 * "Some interruptions" rather than Replacement, so a future change of these indices
 * would reboot an instance rather than recreate it — but it would still be a change to
 * make deliberately.
 */
export const AURORA_WRITER_AZ_INDEX = 1;
export const AURORA_READER_AZ_INDEXES = [0, 2];

export interface AuroraMemberProps {
  /** VPC to place the cluster in. Subnets are the private-isolated tier. */
  readonly vpc: ec2.IVpc;
  /** Name prefix for the CMK alias and the generated secret. */
  readonly namePrefix: string;
  /**
   * Set ONLY on a secondary member: the identifier of the global cluster to JOIN.
   *
   * Presence of this value is what distinguishes the two modes:
   *   absent  → PRIMARY. Creates the admin credentials secret and the initial database.
   *             Deliberately does NOT set `globalClusterIdentifier`; the global cluster
   *             adopts this cluster via `sourceDbClusterIdentifier` instead. Setting it
   *             on the primary reintroduces a CloudFormation delete-time 404 race.
   *   present → SECONDARY. Joins an EXISTING global cluster and therefore must NOT
   *             declare a master username, password or database name — it inherits all
   *             three by replication. Those properties are removed below.
   *
   * Because the secondary joins a global cluster that must already exist, it cannot be
   * deployed before the global cluster. That is why the secondary member lives in its
   * own stack rather than inside the secondary RegionStack.
   */
  readonly joinGlobalClusterId?: string;
}

/**
 * One regional member of the Aurora Global Database.
 */
export class AuroraMember extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly encryptionKey: kms.Key;
  /**
   * The credentials secret RESOURCE, primary member only.
   *
   * Exposed because `cluster.secret` is NOT this: `DatabaseCluster` calls
   * `secret.attach(cluster)`, so `cluster.secret` is a `SecretTargetAttachment` whose
   * `defaultChild` is a `CfnSecretTargetAttachment`. Casting that to `CfnSecret` compiles
   * and then silently does nothing — an assignment to `replicaRegions` on it never
   * reaches the template, with no error anywhere. That was caught by a test asserting the
   * property, not by the compiler.
   *
   * Creating the secret here rather than letting `Credentials.fromGeneratedSecret` create
   * it internally is what makes the real `CfnSecret` reachable.
   */
  public readonly credentialsSecret?: rds.DatabaseSecret;

  constructor(scope: Construct, id: string, props: AuroraMemberProps) {
    super(scope, id);

    const isSecondary = props.joinGlobalClusterId !== undefined;

    // The AZ names are deploy-time tokens (Fn::Select over Fn::GetAZs) supplied by
    // ParameterizedVpc, so the same template places members correctly in a region with
    // any AZ naming. Guarded rather than assumed: with fewer than three AZs the
    // one-member-per-AZ contract below would silently collapse to two zones sharing an
    // instance, which is the failure mode this construct exists to prevent.
    const azs = props.vpc.availabilityZones;
    const azIndexes = [AURORA_WRITER_AZ_INDEX, ...AURORA_READER_AZ_INDEXES];
    const required = Math.max(...azIndexes) + 1;
    if (azs.length < required) {
      throw new Error(
        `AuroraMember needs at least ${required} availability zones to place one member `
        + `per AZ; the VPC has ${azs.length}.`,
      );
    }

    // Each region gets its OWN customer-managed key. Aurora Global Database does not
    // share a key across regions — storage is encrypted per member.
    this.encryptionKey = new kms.Key(this, 'DbEncryptionKey', {
      enableKeyRotation: true,
      alias: `${props.namePrefix}-db-${isSecondary ? 'secondary' : 'primary'}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // PRIMARY ONLY. A member that joins a global cluster inherits its credentials by
    // replication and must not declare any, so the secondary has no secret at all.
    //
    // No `encryptionKey`: the secret uses the AWS-managed `aws/secretsmanager` key, and
    // Secrets Manager performs the decrypt server-side. Giving it a customer-managed key
    // would additionally require every reader to hold kms:Decrypt on that key, which
    // fails as "Access to KMS is not allowed" — an error that reads like an IAM problem.
    // A test asserts no KmsKeyId so that cannot be changed quietly.
    this.credentialsSecret = isSecondary
      ? undefined
      : new rds.DatabaseSecret(this, 'DbSecret', {
        username: 'dbadmin',
        secretName: `${props.namePrefix}/db-credentials`,
      });

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: AURORA_ENGINE_VERSION,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        availabilityZone: azs[AURORA_WRITER_AZ_INDEX],
      }),
      // TWO READERS, ONE IN EACH REMAINING AZ. See AURORA_READER_AZ_INDEXES for why the
      // placement is pinned rather than left to Aurora.
      //
      // The promotion tiers differ ON PURPOSE, and for Aurora Serverless v2 the tier
      // controls capacity as well as failover order (docs: "Choosing the promotion tier
      // for an Aurora serverless reader"):
      //   tier 0-1 → held at a minimum capacity AT LEAST the writer's, so a failover
      //              does not promote a cold, under-sized instance.
      //   tier 2-15 → scales on its own read workload and can idle down to the cluster
      //              floor.
      // So Reader1 is the designated failover target (`scaleWithWriter: true` → tier 1)
      // and Reader2 is read capacity that costs what it uses. Setting BOTH to tier 1
      // would hold two instances at writer capacity for a demo whose writer sits near
      // the floor; setting BOTH to tier 2 would make every failover start cold.
      readers: [
        rds.ClusterInstance.serverlessV2('Reader1', {
          availabilityZone: azs[AURORA_READER_AZ_INDEXES[0]],
          scaleWithWriter: true,
        }),
        rds.ClusterInstance.serverlessV2('Reader2', {
          availabilityZone: azs[AURORA_READER_AZ_INDEXES[1]],
          scaleWithWriter: false,
        }),
      ],
      // Required before ANY db.serverless instance can join the cluster — RDS rejects the
      // instance without it, and the L2 emits it only because an instance asked for
      // serverless. Live-verified 2026-09-04 that db.serverless is orderable for
      // aurora-postgresql 16.8 in every AZ of us-east-2 and us-west-2, so the engine pin
      // above did not have to move.
      serverlessV2MinCapacity: AURORA_MIN_ACU,
      serverlessV2MaxCapacity: AURORA_MAX_ACU,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncryptionKey: this.encryptionKey,
      backup: { retention: cdk.Duration.days(7) },
      // Demo posture, stated rather than defaulted: a left-behind Aurora global cluster
      // costs money after the demo, so teardown must actually remove it.
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(isSecondary
        ? {}
        : {
          // PRIMARY ONLY. The secondary inherits both by replication.
          defaultDatabaseName: 'orders',
          credentials: rds.Credentials.fromSecret(this.credentialsSecret!),
        }),
    });

    if (isSecondary) {
      // Escape hatch: joining an existing global cluster is not expressible on the L2.
      const cfn = this.cluster.node.defaultChild as rds.CfnDBCluster;
      cfn.globalClusterIdentifier = props.joinGlobalClusterId;
      // A member that joins a global cluster MUST NOT declare these — RDS rejects the
      // combination. Deletion overrides rather than simply omitting them, because the
      // L2 synthesizes some of them on its own.
      cfn.addPropertyDeletionOverride('MasterUsername');
      cfn.addPropertyDeletionOverride('MasterUserPassword');
      cfn.addPropertyDeletionOverride('DatabaseName');

      // Drop the secret the L2 generated anyway.
      //
      // `DatabaseCluster` with no `credentials` prop does not mean "no credentials" — it
      // falls back to generating a username and a secret. Deleting the template
      // properties above stops the CLUSTER referencing them, but leaves an orphan
      // Secrets Manager secret holding a generated password that nothing ever reads: cost
      // and clutter, and a live credential with no owner. The secondary genuinely has no
      // credentials of its own; it inherits them by replication.
      //
      // Found by a test asserting the secondary stack creates zero secrets, not by
      // reading the code.
      this.cluster.node.tryRemoveChild('Secret');
    }
  }
}
