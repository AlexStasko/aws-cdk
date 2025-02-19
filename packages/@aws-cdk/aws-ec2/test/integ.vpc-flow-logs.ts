import { PolicyStatement, Effect, ServicePrincipal } from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import { App, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { IntegTest, ExpectedResult, AssertionsProvider } from '@aws-cdk/integ-tests';
import { FlowLog, FlowLogDestination, FlowLogResourceType, Vpc, Instance, InstanceType, InstanceClass, InstanceSize, MachineImage, AmazonLinuxGeneration } from '../lib';

const app = new App();

class FeatureFlagStack extends Stack {
  public readonly bucketArn: string;
  public readonly bucket: s3.IBucket;
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'VPC');

    const flowLog = vpc.addFlowLog('FlowLogsS3', {
      destination: FlowLogDestination.toS3(),
    });
    this.bucket = flowLog.bucket!;
    this.bucketArn = this.exportValue(flowLog.bucket!.bucketArn);

    new Instance(this, 'FlowLogsInstance', {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
      machineImage: MachineImage.latestAmazonLinux({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
    });
  }
}

class TestStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'VPC');

    new FlowLog(this, 'FlowLogsCW', {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });

    vpc.addFlowLog('FlowLogsS3', {
      destination: FlowLogDestination.toS3(),
    });

    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`AWSLogs/${this.account}/*`)],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': this.formatArn({
            service: 'logs',
            resource: '*',
          }),
        },
      },
    }));
    bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': this.formatArn({
            service: 'logs',
            resource: '*',
          }),
        },
      },
    }));

    vpc.addFlowLog('FlowLogsS3KeyPrefix', {
      destination: FlowLogDestination.toS3(bucket, 'prefix/'),
    });
  }
}

const featureFlagTest = new FeatureFlagStack(app, 'FlowLogsFeatureFlag');

const integ = new IntegTest(app, 'FlowLogs', {
  testCases: [
    new TestStack(app, 'FlowLogsTestStack'),
    featureFlagTest,
  ],
});


const objects = integ.assertions.awsApiCall('S3', 'listObjectsV2', {
  Bucket: featureFlagTest.bucket.bucketName,
  MaxKeys: 1,
  Prefix: `AWSLogs/${featureFlagTest.account}/vpcflowlogs`,
});
const assertionProvider = objects.node.tryFindChild('SdkProvider') as AssertionsProvider;
assertionProvider.addPolicyStatementFromSdkCall('s3', 'ListBucket', [featureFlagTest.bucketArn]);
assertionProvider.addPolicyStatementFromSdkCall('s3', 'GetObject', [`${featureFlagTest.bucketArn}/*`]);

objects.expect(ExpectedResult.objectLike({
  KeyCount: 1,
}));

app.synth();
