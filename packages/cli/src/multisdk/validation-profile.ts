import type { MultisdkLanguage } from './language.js';

export type MultisdkValidationProfile = {
  id: string;
  language: MultisdkLanguage;
  title: string;
  containerImage?: string;
  commands: string[];
  notes: string[];
};

const VALIDATION_PROFILES: MultisdkValidationProfile[] = [
  {
    id: 'manta-k8s-maven',
    language: 'java',
    title: 'Manta Kubernetes Maven/JDK validation',
    containerImage: 'maven:3.9-eclipse-temurin-17',
    commands: [
      'mvn test'
    ],
    notes: [
      'Use this profile for Java verifier projects that need both JDK and Maven.',
      'Prefer this over the default Manta sandbox, which may not include java, mvn, root package install, or outbound DNS.'
    ]
  },
  {
    id: 'local-maven',
    language: 'java',
    title: 'Local Maven/JDK validation',
    commands: [
      'mvn test'
    ],
    notes: [
      'Use this profile when a local JDK and Maven installation can reach the configured Milvus endpoint.'
    ]
  },
  {
    id: 'local-node',
    language: 'javascript',
    title: 'Local Node.js validation',
    commands: [
      'npm test'
    ],
    notes: [
      'Use this profile for JavaScript or Node.js verifier projects.'
    ]
  }
];

const DEFAULT_PROFILE_BY_LANGUAGE: Record<MultisdkLanguage, string | undefined> = {
  java: 'manta-k8s-maven',
  javascript: 'local-node',
  go: undefined,
  restful: undefined
};

export function listValidationProfiles(language?: MultisdkLanguage): MultisdkValidationProfile[] {
  return VALIDATION_PROFILES.filter((profile) => !language || profile.language === language);
}

export function defaultValidationProfile(language: MultisdkLanguage): MultisdkValidationProfile {
  const profileId = DEFAULT_PROFILE_BY_LANGUAGE[language];
  if (!profileId) {
    throw new Error(`No default validation profile is defined for ${language}.`);
  }
  return getValidationProfile(language, profileId);
}

export function getValidationProfile(
  language: MultisdkLanguage,
  profileId = DEFAULT_PROFILE_BY_LANGUAGE[language]
): MultisdkValidationProfile {
  if (!profileId) {
    throw new Error(`Validation profile is required for ${language}.`);
  }
  const profile = VALIDATION_PROFILES.find((candidate) => candidate.id === profileId && candidate.language === language);
  if (!profile) {
    const available = listValidationProfiles(language).map((candidate) => candidate.id).join(', ') || 'none';
    throw new Error(`Invalid validation profile ${profileId} for ${language}. Available profiles: ${available}.`);
  }
  return profile;
}
