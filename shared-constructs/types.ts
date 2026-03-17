/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

/**
 * Minimal region config required by shared constructs.
 */
export interface RegionConfig {
  readonly region: string;
  readonly regionPrefix: string;
}

/**
 * Minimal app config required by shared constructs.
 * Each sub-project can extend this with project-specific fields.
 */
export interface AppConfig {
  readonly appName: string;
  readonly envName: string;
  readonly awsDefaultRegion: string;
  readonly primaryRegion: RegionConfig;
  readonly secondaryRegion: RegionConfig;
}
