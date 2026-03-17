# AWS Resilience Patterns — Sample Implementations

![s3mrap-crr build](https://github.com/aws-samples/sample-resilience-patterns/actions/workflows/s3mrap-crr-build.yml/badge.svg)
![s3mrap-crr e2e](https://github.com/aws-samples/sample-resilience-patterns/actions/workflows/s3mrap-crr-e2e.yml/badge.svg)

A collection of sample implementations demonstrating resilient architectures for common AWS services and patterns. Each subdirectory is a standalone, fully deployable reference implementation.

## Purpose

These samples show how to build resilient, multi-region, and fault-tolerant systems on AWS. They are intended as **reference implementations** — study them, learn from them, adapt them to your needs. They are **not intended for direct production use** without review and customization for your specific requirements.

## Samples

| Directory | Description |
|-----------|-------------|
| [`s3mrap-crr/`](s3mrap-crr/) | S3 Multi-Region Access Points with bidirectional Cross-Region Replication, ARC-based failover, CloudWatch observability, and replication latency load testing |

## Technology

All samples are written in **AWS CDK (TypeScript)**. Each sample includes:

- CDK stacks with full infrastructure definitions
- CDK assertion tests for template validation
- Deployment automation (Makefile, CodeBuild, or both)
- Cleanup scripts for teardown
- README with architecture diagrams, prerequisites, and walkthrough

### Extracting CloudFormation Templates

If you prefer raw CloudFormation over CDK, you can extract the templates from any sample:

```bash
cd <sample-directory>
npm install
npx cdk synth                          # Synthesize all stacks
ls cdk.out/*.template.json             # CloudFormation templates are here
```

Each `.template.json` file is a standalone CloudFormation template that can be deployed directly with `aws cloudformation deploy` or through the CloudFormation console.

## Disclaimer

These samples are provided for **educational and reference purposes only**. They are not production-ready as-is. Before using any pattern in production:

- Review and adjust IAM permissions for least privilege
- Evaluate encryption, logging, and compliance requirements
- Test failover and recovery procedures in your environment
- Adjust resource sizing, retention policies, and alarm thresholds

## Contributing

Each sample is self-contained. See the README in each subdirectory for development setup and testing instructions.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
