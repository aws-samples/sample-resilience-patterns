/**
 * Networking pattern — public API barrel.
 *
 * M1a (always-on): ParameterizedVpc, RegionalNetwork.
 * M5 (multi-region): PeeringMesh + PeerDescriptor (the peering-configurator Lambda
 *   ships as a vendored .py asset under ./peering-configurator/, consumed by
 *   PeeringMesh via Code.fromAsset; it is not a TS export).
 */
export * from './parameterized-vpc.js';
export * from './regional-network.js';
export * from './peering-mesh.js';
