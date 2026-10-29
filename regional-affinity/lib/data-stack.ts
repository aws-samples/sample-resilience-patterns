import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  readonly tableName: string;
  /** The Region that gets the second replica (this stack's Region holds the first). */
  readonly replicaRegion: string;
}

/**
 * The data store: one DynamoDB global table with a replica in each Region, using multi-Region
 * eventual consistency (MREC). Both replicas accept writes, replication is asynchronous, and the
 * last writer wins when both Regions write the same item. One stack manages both replicas.
 *
 * One partition per customer: the item with record `profile` names the customer's home Region;
 * items with record `item#<key>` are the data the app reads and writes.
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'Customers', {
      tableName: props.tableName,
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'record', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      multiRegionConsistency: dynamodb.MultiRegionConsistency.EVENTUAL,
      replicas: [{ region: props.replicaRegion }],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Off, and the table is deleted with the stack, so cleanup leaves nothing behind.
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
