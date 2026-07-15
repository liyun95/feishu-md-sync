import { writeFile } from 'node:fs/promises';

const required = [
  'PACKAGE_NAME',
  'PACKAGE_VERSION',
  'PACKAGE_INTEGRITY',
  'SIGSTORE_BUNDLE_PATH'
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const registry = 'https://registry.npmjs.org';
const packageSpec = `${process.env.PACKAGE_NAME}@${process.env.PACKAGE_VERSION}`;
const metadataUrl = `${registry}/${encodeURIComponent(process.env.PACKAGE_NAME)}/${process.env.PACKAGE_VERSION}`;
const metadataResponse = await fetch(metadataUrl);
if (!metadataResponse.ok) {
  throw new Error(`Cannot read npm metadata for ${packageSpec}: HTTP ${metadataResponse.status}`);
}

const metadata = await metadataResponse.json();
if (metadata.dist?.integrity !== process.env.PACKAGE_INTEGRITY) {
  throw new Error(`npm integrity for ${packageSpec} does not match the packed release artifact`);
}

const attestationsUrl = metadata.dist?.attestations?.url;
if (!attestationsUrl) throw new Error(`npm provenance is missing for ${packageSpec}`);
const attestationsResponse = await fetch(attestationsUrl);
if (!attestationsResponse.ok) {
  throw new Error(`Cannot read npm attestations for ${packageSpec}: HTTP ${attestationsResponse.status}`);
}

const attestations = await attestationsResponse.json();
const provenance = attestations.attestations?.find((entry) => {
  return entry.predicateType === 'https://slsa.dev/provenance/v1';
});
if (!provenance) throw new Error(`SLSA provenance is missing for ${packageSpec}`);

await writeFile(process.env.SIGSTORE_BUNDLE_PATH, JSON.stringify(provenance.bundle));
console.log(`Downloaded npm provenance bundle for ${packageSpec}`);
