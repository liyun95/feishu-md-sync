const required = [
  'PACKAGE_NAME',
  'PACKAGE_VERSION',
  'PACKAGE_INTEGRITY',
  'EXPECTED_REPOSITORY',
  'EXPECTED_SHA',
  'EXPECTED_REF',
  'EXPECTED_WORKFLOW'
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
if (metadata.gitHead && metadata.gitHead !== process.env.EXPECTED_SHA) {
  throw new Error(`npm gitHead for ${packageSpec} is ${metadata.gitHead}, expected ${process.env.EXPECTED_SHA}`);
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

const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
if (workflow?.repository !== process.env.EXPECTED_REPOSITORY) {
  throw new Error(`Provenance repository is ${workflow?.repository}, expected ${process.env.EXPECTED_REPOSITORY}`);
}
if (workflow?.path !== process.env.EXPECTED_WORKFLOW) {
  throw new Error(`Provenance workflow is ${workflow?.path}, expected ${process.env.EXPECTED_WORKFLOW}`);
}
if (workflow?.ref !== process.env.EXPECTED_REF) {
  throw new Error(`Provenance ref is ${workflow?.ref}, expected ${process.env.EXPECTED_REF}`);
}

const resolvedDependencies = statement.predicate?.buildDefinition?.resolvedDependencies ?? [];
const commitMatches = resolvedDependencies.some((entry) => {
  return entry.digest?.gitCommit === process.env.EXPECTED_SHA;
});
if (!commitMatches) throw new Error(`Provenance does not resolve to commit ${process.env.EXPECTED_SHA}`);

const expectedDigest = Buffer.from(process.env.PACKAGE_INTEGRITY.slice('sha512-'.length), 'base64').toString('hex');
const subjectMatches = statement.subject?.some((subject) => {
  return subject.name === `pkg:npm/${packageSpec}` && subject.digest?.sha512 === expectedDigest;
});
if (!subjectMatches) throw new Error(`Provenance subject does not match ${packageSpec}`);

console.log(JSON.stringify({
  package: packageSpec,
  integrity: metadata.dist.integrity,
  ref: workflow.ref,
  commit: process.env.EXPECTED_SHA
}));
