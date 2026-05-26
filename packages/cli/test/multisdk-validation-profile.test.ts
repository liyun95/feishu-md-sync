import { describe, expect, it } from 'vitest';
import { defaultValidationProfile, getValidationProfile } from '../src/multisdk/validation-profile.js';

describe('multisdk validation profiles', () => {
  it('defaults Java validation to a Maven/JDK container profile', () => {
    const profile = defaultValidationProfile('java');

    expect(profile.id).toBe('manta-k8s-maven');
    expect(profile.containerImage).toBe('maven:3.9-eclipse-temurin-17');
    expect(profile.notes.join(' ')).toContain('default Manta sandbox');
  });

  it('rejects profiles that do not belong to the requested language', () => {
    expect(() => getValidationProfile('java', 'local-node')).toThrow(/Invalid validation profile/);
  });
});
