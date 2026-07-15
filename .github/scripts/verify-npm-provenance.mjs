import { readFile } from 'node:fs/promises';

const required = [
  'PACKAGE_NAME',
  'PACKAGE_VERSION',
  'PACKAGE_INTEGRITY',
  'EXPECTED_REPOSITORY',
  'EXPECTED_SHA',
  'EXPECTED_REF',
  'EXPECTED_WORKFLOW',
  'EXPECTED_BUILD_TYPE',
  'EXPECTED_BUILDER',
  'EXPECTED_EVENT',
  'SIGSTORE_BUNDLE_PATH'
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const packageSpec = `${process.env.PACKAGE_NAME}@${process.env.PACKAGE_VERSION}`;
const bundle = JSON.parse(await readFile(process.env.SIGSTORE_BUNDLE_PATH, 'utf8'));
const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
const buildDefinition = statement.predicate?.buildDefinition;
if (buildDefinition?.buildType !== process.env.EXPECTED_BUILD_TYPE) {
  throw new Error(`Provenance build type is ${buildDefinition?.buildType}, expected ${process.env.EXPECTED_BUILD_TYPE}`);
}
const builder = statement.predicate?.runDetails?.builder?.id;
if (builder !== process.env.EXPECTED_BUILDER) {
  throw new Error(`Provenance builder is ${builder}, expected ${process.env.EXPECTED_BUILDER}`);
}
const eventName = buildDefinition?.internalParameters?.github?.event_name;
if (eventName !== process.env.EXPECTED_EVENT) {
  throw new Error(`Provenance event is ${eventName}, expected ${process.env.EXPECTED_EVENT}`);
}
const workflow = buildDefinition?.externalParameters?.workflow;
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
  integrity: process.env.PACKAGE_INTEGRITY,
  ref: workflow.ref,
  commit: process.env.EXPECTED_SHA
}));
