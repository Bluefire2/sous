import { describe, expect, it } from 'vitest';
import {
  deletionRefusal,
  FIRESTORE_COLLECTIONS,
  forwardGrantNeedsTombstone,
  invitePlan,
  ownerShareNeedsTombstone,
  personalTopLevelCollections,
  viewerShareTarget,
} from './accountDeletion.ts';
import {
  grantCascadeRevoke,
  incomingShareCascadeDoc,
  incomingSharePayload,
  revokeGrantTransition,
  shareGrantId,
} from './grants.ts';

const SUB = '109876543210987654321';
const OWNER = '123456789012345678901';
const COLLECTION = '0b6f6a6e-3a3c-4c55-9a59-3f0c8c1d2e4f';

describe('FIRESTORE_COLLECTIONS', () => {
  it('marks every top-level collection that holds a member as personal, and only the counter as not', () => {
    expect(personalTopLevelCollections().sort()).toEqual(
      [
        'accessRequests',
        'collectionLinks',
        'featureRequests',
        'importFeedback',
        'incomingShares',
        'invites',
        'mcpAuthCodes',
        'mcpTokens',
        'members',
        'publicLinks',
        'recipeLinks',
        'users',
      ].sort(),
    );
    expect(FIRESTORE_COLLECTIONS.accessRequestMeta).toMatchObject({ scope: 'top-level', personal: false });
  });
});

describe('deletionRefusal', () => {
  const base = {
    sub: SUB,
    memberStatus: 'revoked',
    emails: ['gone@example.com'],
    allowedRaw: 'owner@example.com',
    notOwnerConfirmed: false,
  };

  it('allows a member whose access is already denied', () => {
    expect(deletionRefusal(base)).toBeNull();
    expect(deletionRefusal({ ...base, memberStatus: undefined })).toBeNull();
  });

  it('refuses while the member is still active or an owner, or when owners cannot be ruled out', () => {
    expect(deletionRefusal({ ...base, memberStatus: 'active' })).toBe('still-member');
    expect(deletionRefusal({ ...base, emails: ['Owner@Example.com'] })).toBe('owner');
    // Any stored address counts, not only the profile's.
    expect(deletionRefusal({ ...base, emails: ['gone@example.com', 'owner@example.com'] })).toBe('owner');
    expect(deletionRefusal({ ...base, allowedRaw: '  ' })).toBe('no-allowlist');
  });

  it('refuses a sub with no email on record until the operator confirms it is not an owner', () => {
    expect(deletionRefusal({ ...base, emails: [] })).toBe('no-email');
    expect(deletionRefusal({ ...base, emails: [], notOwnerConfirmed: true })).toBeNull();
    // The confirmation never overrides a stored owner address.
    expect(deletionRefusal({ ...base, emails: ['owner@example.com'], notOwnerConfirmed: true })).toBe('owner');
  });

  it('refuses a sub that is not a document id', () => {
    expect(deletionRefusal({ ...base, sub: 'a/b' })).toBe('bad-sub');
    expect(deletionRefusal({ ...base, sub: '' })).toBe('bad-sub');
  });
});

describe('invitePlan', () => {
  it('deletes what the member minted and scrubs what they redeemed from someone else', () => {
    expect(
      invitePlan(
        ['minted-1', 'minted-2'],
        [
          { id: 'from-owner', createdBy: OWNER },
          { id: 'minted-1', createdBy: SUB },
        ],
        SUB,
      ),
    ).toEqual({ deleteIds: ['minted-1', 'minted-2'], scrubIds: ['from-owner'] });
  });
});

describe('ownerShareNeedsTombstone', () => {
  it('is true for a live share or a tombstone that still carries the owner email', () => {
    const live = incomingSharePayload(OWNER, COLLECTION, 5, { ownerEmail: 'owner@example.com', role: 'viewer' });
    expect(ownerShareNeedsTombstone(live)).toBe(true);
    expect(ownerShareNeedsTombstone({ ...live, deletedAt: 6 })).toBe(true);
    expect(ownerShareNeedsTombstone({ ownerEmail: 'x@example.com' })).toBe(true);
  });

  it('is false for a missing share or a clean tombstone, which is what the step writes', () => {
    expect(ownerShareNeedsTombstone(undefined)).toBe(false);
    const written = incomingShareCascadeDoc(undefined, OWNER, COLLECTION, 9);
    expect(written).not.toHaveProperty('ownerEmail');
    expect(ownerShareNeedsTombstone(written)).toBe(false);
  });
});

describe('viewerShareTarget', () => {
  it('reads the owner and collection from the share, or from its id when the share is unreadable', () => {
    const id = shareGrantId(OWNER, COLLECTION);
    const live = incomingSharePayload(OWNER, COLLECTION, 5, { ownerEmail: 'owner@example.com', role: 'viewer' });
    expect(viewerShareTarget(id, live)).toEqual({ ownerSub: OWNER, collectionId: COLLECTION });
    expect(viewerShareTarget(id, { ownerEmail: 'owner@example.com' })).toEqual({ ownerSub: OWNER, collectionId: COLLECTION });
    expect(viewerShareTarget(id, undefined)).toEqual({ ownerSub: OWNER, collectionId: COLLECTION });
  });

  it('keeps an owner sub that holds an underscore, because a collection id never does', () => {
    expect(viewerShareTarget(shareGrantId('a_b', COLLECTION), {})).toEqual({ ownerSub: 'a_b', collectionId: COLLECTION });
  });

  it('is null when neither names a usable path', () => {
    expect(viewerShareTarget('no-underscore', {})).toBeNull();
    expect(viewerShareTarget(`${OWNER}_not-a-uuid`, {})).toBeNull();
    expect(viewerShareTarget(`_${COLLECTION}`, {})).toBeNull();
    expect(viewerShareTarget(`a/b_${COLLECTION}`, {})).toBeNull();
    const pathy = incomingSharePayload('a/b', COLLECTION, 5, { ownerEmail: 'owner@example.com', role: 'viewer' });
    expect(viewerShareTarget(shareGrantId(OWNER, COLLECTION), pathy)).toBeNull();
  });
});

describe('forwardGrantNeedsTombstone', () => {
  it('is false for a missing grant or a tombstone without an email, which both writers produce', () => {
    expect(forwardGrantNeedsTombstone(undefined)).toBe(false);
    expect(forwardGrantNeedsTombstone(grantCascadeRevoke(null, SUB, 9))).toBe(false);
    const live = {
      viewerSub: SUB,
      email: 'viewer@example.com',
      collectionId: COLLECTION,
      role: 'viewer' as const,
      createdAt: 1,
      updatedAt: 2,
      active: true as const,
    };
    const revoked = revokeGrantTransition({ existing: live, viewerSub: SUB, now: 9 });
    expect(revoked.kind).toBe('write');
    if (revoked.kind === 'write') expect(forwardGrantNeedsTombstone(revoked.doc)).toBe(false);
  });

  it('is true for a live grant, a tombstone that kept the email, or a document that cannot be read', () => {
    expect(forwardGrantNeedsTombstone({ viewerSub: SUB, email: 'viewer@example.com', active: true })).toBe(true);
    expect(forwardGrantNeedsTombstone({ viewerSub: SUB, deletedAt: 9, email: 'viewer@example.com' })).toBe(true);
    expect(forwardGrantNeedsTombstone({ viewerSub: 'someone-else' })).toBe(true);
    expect(forwardGrantNeedsTombstone(null)).toBe(true);
  });
});
