/**
 * Policy guard: the declared proof-policy descriptor is canonical and pinned.
 * It contains no gate source text, so comment-only or unrelated code changes
 * cannot invalidate it. A semantic descriptor edit must bump the policy
 * version and record the new semantic fingerprint deliberately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_PROOF_POLICY_VERSION,
  FINGERPRINT_VERSION,
  POLICY_VERSION_HISTORY,
  PROOF_POLICY_DESCRIPTOR,
  SEMANTIC_GATE_POLICY_VERSION,
  proofPolicyFingerprint,
  proofPolicySemanticFingerprint,
  proofPolicyVersionFor,
} from '../../fanfable/src/court/claim-proof.ts';

const EXPECTED_POLICY_VERSION = 'claim-proof-v1';
const EXPECTED_POLICY_FINGERPRINT = '9f37e1ab74e9c6e79642760830b04ce59adab2cbd1611058b3ec22274cad9f11';
const EXPECTED_SEMANTIC_FINGERPRINT = '2c1ebf0043de4c413054410cbf02cb3f84fc55ddc57855029a35687d43152395';

test('the declared descriptor is canonical, complete and pinned', () => {
  assert.equal(CURRENT_PROOF_POLICY_VERSION, EXPECTED_POLICY_VERSION);
  assert.equal(PROOF_POLICY_DESCRIPTOR.policyVersion, EXPECTED_POLICY_VERSION);
  assert.equal(PROOF_POLICY_DESCRIPTOR.semanticGatePolicyVersion, SEMANTIC_GATE_POLICY_VERSION);
  assert.equal(PROOF_POLICY_DESCRIPTOR.fingerprintVersion, FINGERPRINT_VERSION);
  assert.deepEqual([...PROOF_POLICY_DESCRIPTOR.standards], ['sentence', 'passage', 'identity', 'none']);
  assert.deepEqual(
    [...PROOF_POLICY_DESCRIPTOR.storedOutcomes],
    ['verified', 'failed', 'not_evaluated', 'legacy_unknown'],
  );
  assert.deepEqual(
    [...PROOF_POLICY_DESCRIPTOR.effectiveOutcomes],
    ['verified', 'failed', 'not_evaluated', 'legacy_unknown', 'stale', 'unavailable'],
  );
  assert.deepEqual(Object.keys(PROOF_POLICY_DESCRIPTOR).sort(), [
    'authority',
    'effectiveOutcomes',
    'fingerprintVersion',
    'policyVersion',
    'resolverRule',
    'semanticGatePolicyVersion',
    'standards',
    'storedOutcomes',
  ]);
  assert.equal(proofPolicyFingerprint(), EXPECTED_POLICY_FINGERPRINT);
  assert.equal(proofPolicySemanticFingerprint(), EXPECTED_SEMANTIC_FINGERPRINT);
  assert.equal(proofPolicyVersionFor(PROOF_POLICY_DESCRIPTOR), EXPECTED_POLICY_VERSION);
});

test('a descriptor change without a version bump is rejected', () => {
  const changed = {
    ...PROOF_POLICY_DESCRIPTOR,
    resolverRule: 'latest-attempt-with-fallback',
  };
  assert.throws(
    () => proofPolicyVersionFor(changed),
    /descriptor changed without a policy-version bump/,
  );
  assert.notEqual(proofPolicyFingerprint(changed), EXPECTED_POLICY_FINGERPRINT);
});

test('a legitimate version bump records a new expected fingerprint', () => {
  const bumped = {
    ...PROOF_POLICY_DESCRIPTOR,
    policyVersion: 'claim-proof-v2',
    semanticGatePolicyVersion: 'gate-semantics-v2',
    resolverRule: 'latest-attempt-no-fallback-v2',
  };
  const semantic = proofPolicySemanticFingerprint(bumped);
  const history = { ...POLICY_VERSION_HISTORY, 'claim-proof-v2': semantic };
  assert.equal(proofPolicyVersionFor(bumped, history), 'claim-proof-v2');
  assert.notEqual(proofPolicyFingerprint(bumped), EXPECTED_POLICY_FINGERPRINT);
  assert.equal(proofPolicyFingerprint(bumped), proofPolicyFingerprint({ ...bumped }));
});

test('unrelated metadata and comment-only style changes do not invalidate policy', () => {
  const withUnrelatedMetadata = {
    ...PROOF_POLICY_DESCRIPTOR,
    comment: 'a comment is not part of the policy contract',
  };
  assert.equal(proofPolicyFingerprint(withUnrelatedMetadata), EXPECTED_POLICY_FINGERPRINT);
  assert.equal(proofPolicySemanticFingerprint(withUnrelatedMetadata), EXPECTED_SEMANTIC_FINGERPRINT);
  assert.equal(proofPolicyVersionFor(withUnrelatedMetadata), EXPECTED_POLICY_VERSION);
});
