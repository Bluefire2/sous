import { describe, expect, it } from 'vitest';
import {
  LIVE_GRANT_QUERY_LIMIT,
  MAX_LIVE_GRANTS,
  addGrantTransition,
  canonicalCollectionTombstoneAt,
  cascadeGrantPairTransition,
  collectionIsCanonicalTombstoneAt,
  collectionLiveForGrant,
  deleteRevokingPublicLinks,
  grantCascadeRevoke,
  incomingShareCascadeDoc,
  isSafeFirestoreDocumentId,
  normalizeShareEmail,
  orchestrateCollectionGrantDelete,
  orchestrateGrantAdd,
  orchestrateGrantRevoke,
  parseGrantDoc,
  parseIncomingShareDoc,
  queryShareProfileRows,
  resolveShareTarget,
  revokeGrantTransition,
  sessionCanViewOwnerPhoto,
  type CollectionGrantDeleteTransaction,
  type GrantAddTransaction,
  type GrantTombstone,
  type LiveGrant,
  type LiveIncomingShare,
  type RevokeGrantDependencies,
  type SessionCanViewOwnerPhotoInput,
} from './grants.ts';
import type { StoreKind } from './store.ts';

const viewerSub = 'viewer-1';
const collectionId = '11111111-1111-4111-8111-111111111111';
const secondCollectionId = '22222222-2222-4222-8222-222222222222';
const recipeId = '33333333-3333-4333-8333-333333333333';
const secondRecipeId = '44444444-4444-4444-8444-444444444444';

function liveCollection(id: string, recipeIds: string[]) {
  return { id, name: 'Shared', recipeIds, createdAt: 1, updatedAt: 2 };
}

function liveRecipe(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Recipe ${id}`,
    servings: 2,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

function livePhoto(parentRecipeId: string) {
  return {
    id: 'photo-target',
    recipeId: parentRecipeId,
    status: 'live',
    contentType: 'image/jpeg',
    size: 10,
    updatedAt: 2,
  };
}

function docKey(uid: string, kind: StoreKind, id: string): string {
  return `${uid}/${kind}/${id}`;
}

function photoAccessInput(input: {
  ownerSub?: string;
  photoId?: string;
  shares: LiveIncomingShare[];
  current?: Map<string, LiveIncomingShare | undefined>;
  docs?: Map<string, Record<string, unknown> | undefined>;
  calls?: string[];
  ownerAdmitted?: (ownerSub: string) => Promise<boolean>;
}): SessionCanViewOwnerPhotoInput {
  return {
    viewerSub,
    ownerSub: input.ownerSub ?? 'owner',
    photoId: input.photoId ?? 'photo-target',
    listLiveIncomingShares: async (requestedViewer) => {
      input.calls?.push(`list:${requestedViewer}`);
      return input.shares;
    },
    readLiveIncomingShare: async (requestedViewer, grantId) => {
      input.calls?.push(`share:${requestedViewer}:${grantId}`);
      return input.current?.has(grantId)
        ? input.current.get(grantId)
        : input.shares.find((share) => share.grantId === grantId);
    },
    ownerAdmitted: async (ownerSub) => {
      input.calls?.push(`owner:${ownerSub}`);
      return input.ownerAdmitted ? input.ownerAdmitted(ownerSub) : true;
    },
    readDocData: async (uid, kind, id) => {
      input.calls?.push(`doc:${uid}:${kind}:${id}`);
      return input.docs?.get(docKey(uid, kind, id));
    },
  };
}

describe('normalizeShareEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeShareEmail('  Alex@Example.com ')).toBe('alex@example.com');
    expect(normalizeShareEmail('')).toBeUndefined();
    expect(normalizeShareEmail('no-at')).toBeUndefined();
  });
});

describe('isSafeFirestoreDocumentId', () => {
  it('accepts unchanged document ids through the 1,500-byte UTF-8 limit', () => {
    expect(isSafeFirestoreDocumentId('viewer-123')).toBe(true);
    expect(isSafeFirestoreDocumentId('üser')).toBe(true);
    expect(isSafeFirestoreDocumentId('a'.repeat(1_500))).toBe(true);
    expect(isSafeFirestoreDocumentId('é'.repeat(750))).toBe(true);
  });

  it.each([
    undefined,
    '',
    ' viewer',
    'viewer ',
    'viewer/sub',
    '.',
    '..',
    '__viewer__',
    'a'.repeat(1_501),
    'é'.repeat(751),
  ])('rejects unsafe document id %j', (candidate) => {
    expect(isSafeFirestoreDocumentId(candidate)).toBe(false);
  });
});

describe('queryShareProfileRows', () => {
  type StoredProfile = {
    sub: string;
    email: string;
    emailLower?: string;
    lastSeenAt: number;
  };

  function exactProfileQuery(
    profiles: StoredProfile[],
    calls: string[],
  ) {
    return async (field: 'emailLower' | 'email', email: string) => {
      calls.push(`${field}:${email}`);
      return profiles
        .filter((profile) => profile[field] === email)
        .map(({ sub, email: storedEmail, lastSeenAt }) => ({
          sub,
          email: storedEmail,
          lastSeenAt,
        }));
    };
  }

  it('uses emailLower first and does not fall back after a primary match', async () => {
    const calls: string[] = [];
    const rows = await queryShareProfileRows(
      'alex@example.com',
      exactProfileQuery(
        [
          {
            sub: 'new-profile',
            email: 'Alex@Example.com',
            emailLower: 'alex@example.com',
            lastSeenAt: 10,
          },
          {
            sub: 'legacy-profile',
            email: 'alex@example.com',
            lastSeenAt: 20,
          },
        ],
        calls,
      ),
    );

    expect(rows.map((row) => row.sub)).toEqual(['new-profile']);
    expect(calls).toEqual(['emailLower:alex@example.com']);
  });

  it('falls back to an exact normalized email for a lowercase legacy profile', async () => {
    const calls: string[] = [];
    const rows = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery(
        [
          {
            sub: 'legacy-profile',
            email: 'legacy@example.com',
            lastSeenAt: 10,
          },
        ],
        calls,
      ),
    );

    expect(rows.map((row) => row.sub)).toEqual(['legacy-profile']);
    expect(calls).toEqual([
      'emailLower:legacy@example.com',
      'email:legacy@example.com',
    ]);
  });

  it('cannot find a mixed-case legacy profile until emailLower is backfilled', async () => {
    const profile: StoredProfile = {
      sub: 'legacy-profile',
      email: 'Legacy@Example.com',
      lastSeenAt: 10,
    };
    const before = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery([profile], []),
    );
    expect(before).toEqual([]);

    profile.emailLower = 'legacy@example.com';
    const after = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery([profile], []),
    );
    expect(after.map((row) => row.sub)).toEqual(['legacy-profile']);
  });

  it('propagates primary and fallback query failures', async () => {
    await expect(
      queryShareProfileRows('target@example.com', async () => {
        throw new Error('primary unavailable');
      }),
    ).rejects.toThrow('primary unavailable');

    await expect(
      queryShareProfileRows('target@example.com', async (field) => {
        if (field === 'emailLower') {
          return [];
        }
        throw new Error('fallback unavailable');
      }),
    ).rejects.toThrow('fallback unavailable');
  });
});

describe('resolveShareTarget', () => {
  const base = {
    email: 'target@example.com',
    actorSub: 'actor',
    actorEmail: 'actor@example.com',
  };

  it('selects the latest profile and admits an active member', async () => {
    const memberReads: string[] = [];
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'older', email: 'target@example.com', lastSeenAt: 1 },
        { sub: 'latest', email: 'Target@Example.com', lastSeenAt: 9 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async (sub) => {
        memberReads.push(sub);
        return 'active';
      },
    });

    expect(target).toEqual({
      kind: 'ok',
      sub: 'latest',
      email: 'Target@Example.com',
    });
    expect(memberReads).toEqual(['latest']);
  });

  it('rejects self by the selected profile sub', async () => {
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'actor', email: 'other@example.com', lastSeenAt: 1 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(target).toEqual({ kind: 'self' });
  });

  it('admits an owner without reading membership', async () => {
    let memberRead = false;
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'owner', email: 'Owner@Example.com', lastSeenAt: 1 },
      ],
      isOwnerEmail: (email) => email === 'Owner@Example.com',
      readMemberStatus: async () => {
        memberRead = true;
        return null;
      },
    });
    expect(target).toEqual({
      kind: 'ok',
      sub: 'owner',
      email: 'Owner@Example.com',
    });
    expect(memberRead).toBe(false);
  });

  it('keeps no match as notFound and query failure as unknown', async () => {
    const notFound = await resolveShareTarget({
      ...base,
      queryUsers: async () => [],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(notFound).toEqual({ kind: 'notFound' });

    const unknown = await resolveShareTarget({
      ...base,
      queryUsers: async () => {
        throw new Error('query unavailable');
      },
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(unknown).toEqual({ kind: 'unknown' });
  });
});

describe('parseGrantDoc', () => {
  it('parses a live grant and a tombstone', () => {
    expect(
      parseGrantDoc(
        {
          viewerSub,
          email: 'alex@example.com',
          collectionId,
          createdAt: 1,
          updatedAt: 2,
        },
        viewerSub,
      ),
    ).toEqual({
      viewerSub,
      email: 'alex@example.com',
      collectionId,
      role: 'viewer' as const,
      createdAt: 1,
      updatedAt: 2,
      active: true,
    });
    expect(
      parseGrantDoc({ viewerSub, updatedAt: 3, deletedAt: 3 }, viewerSub),
    ).toEqual({ viewerSub, updatedAt: 3, deletedAt: 3, active: false });
  });

  it('rejects the wrong viewer or a missing collection', () => {
    expect(
      parseGrantDoc(
        {
          viewerSub: 'other',
          email: 'a@b.c',
          collectionId,
          createdAt: 1,
          updatedAt: 2,
        },
        viewerSub,
      ),
    ).toBeNull();
  });
});

describe('addGrantTransition', () => {
  it('rejects adding yourself via resolveShareTarget', async () => {
    const self = await resolveShareTarget({
      email: 'me@example.com',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsers: async () => [],
      isOwnerEmail: () => false,
      readMemberStatus: async () => null,
    });
    expect(self).toEqual({ kind: 'self' });
  });

  it('rejects a revoked member and treats a read throw as unknown', async () => {
    const revoked = await resolveShareTarget({
      email: 'revoked@example.com',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsers: async () => [
        { sub: 'r1', email: 'revoked@example.com', lastSeenAt: 9 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'revoked',
    });
    expect(revoked).toEqual({ kind: 'notFound' });

    const unknown = await resolveShareTarget({
      email: 'x@y.z',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsers: async () => [{ sub: 'x', email: 'x@y.z', lastSeenAt: 1 }],
      isOwnerEmail: () => false,
      readMemberStatus: async () => {
        throw new Error('blip');
      },
    });
    expect(unknown).toEqual({ kind: 'unknown' });
  });

  it('is idempotent for a live grant and caps at 20', () => {
    const live = {
      viewerSub,
      email: 'alex@example.com',
      collectionId,
      role: 'viewer' as const,
      createdAt: 1,
      updatedAt: 2,
      active: true as const,
    };
    expect(
      addGrantTransition({
        existing: live,
        viewerSub,
        email: live.email,
        collectionId,
        role: 'viewer',
        now: 10,
        liveCount: 1,
      }).kind,
    ).toBe('idempotent');
    expect(
      addGrantTransition({
        existing: null,
        viewerSub,
        email: live.email,
        collectionId,
        role: 'viewer',
        now: 10,
        liveCount: MAX_LIVE_GRANTS,
      }).kind,
    ).toBe('cap');
    expect(
      addGrantTransition({
        existing: null,
        viewerSub,
        email: live.email,
        collectionId,
        role: 'viewer',
        now: 10,
        liveCount: 0,
      }),
    ).toEqual({
      kind: 'write',
      doc: {
        viewerSub,
        email: live.email,
        collectionId,
        role: 'viewer' as const,
        createdAt: 10,
        updatedAt: 10,
        active: true,
      },
    });
  });
});

describe('revokeGrantTransition', () => {
  it('distinguishes missing, live, and already-tombstoned grants', () => {
    expect(
      revokeGrantTransition({
        existing: null,
        viewerSub,
        now: 9,
      }),
    ).toEqual({ kind: 'missing' });

    const write = revokeGrantTransition({
      existing: {
        viewerSub,
        email: 'a@b.c',
        collectionId,
        role: 'viewer' as const,
        createdAt: 1,
        updatedAt: 2,
        active: true,
      },
      viewerSub,
      now: 9,
    });
    expect(write).toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });
    const stored = { viewerSub, updatedAt: 4, deletedAt: 4, active: false as const };
    expect(
      revokeGrantTransition({
        existing: stored,
        viewerSub,
        now: 9,
      }),
    ).toEqual({ kind: 'already', doc: stored });
  });
});

describe('orchestrateGrantRevoke', () => {
  function dependenciesFor(
    existing: LiveGrant | GrantTombstone | null,
    calls: string[],
    writes: Array<{ viewerSub: string; tombstone: GrantTombstone }>,
  ): RevokeGrantDependencies {
    return {
      runTransaction: async (work) => {
        calls.push('transaction');
        return work({
          readForwardGrant: async (requestedViewerSub) => {
            calls.push(`read:${requestedViewerSub}`);
            return existing;
          },
          writePair: async (requestedViewerSub, tombstone) => {
            calls.push(`write:${requestedViewerSub}`);
            writes.push({ viewerSub: requestedViewerSub, tombstone });
          },
        });
      },
    };
  }

  it('does not invoke a transaction, read, or write dependency for malformed input', async () => {
    for (const malformed of [
      '',
      ' viewer ',
      'viewer/sub',
      '.',
      '..',
      '__viewer__',
      'a'.repeat(1_501),
    ]) {
      const calls: string[] = [];
      const writes: Array<{
        viewerSub: string;
        tombstone: GrantTombstone;
      }> = [];
      await expect(
        orchestrateGrantRevoke(
          malformed,
          9,
          dependenciesFor(null, calls, writes),
        ),
      ).resolves.toEqual({ kind: 'badRequest' });
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  it('reads the authoritative grant but does not write when it is missing', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(null, calls, writes),
      ),
    ).resolves.toEqual({ kind: 'missing' });
    expect(calls).toEqual(['transaction', `read:${viewerSub}`]);
    expect(writes).toEqual([]);
  });

  it('returns the stored tombstone without a paired write', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    const stored = { viewerSub, updatedAt: 4, deletedAt: 4, active: false as const };
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(stored, calls, writes),
      ),
    ).resolves.toEqual({ kind: 'already', doc: stored });
    expect(calls).toEqual(['transaction', `read:${viewerSub}`]);
    expect(writes).toEqual([]);
  });

  it('performs exactly one paired write for a live grant', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    const live: LiveGrant = {
      viewerSub,
      email: 'viewer@example.com',
      collectionId,
      role: 'viewer' as const,
      createdAt: 1,
      updatedAt: 2,
      active: true,
    };
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(live, calls, writes),
      ),
    ).resolves.toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });
    expect(calls).toEqual([
      'transaction',
      `read:${viewerSub}`,
      `write:${viewerSub}`,
    ]);
    expect(writes).toEqual([
      {
        viewerSub,
        tombstone: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
      },
    ]);
  });
});

describe('leave reuses the revoke transition and cannot resurrect a grant', () => {
  it('owner revoke then viewer leave: the second call finds it already gone', async () => {
    const calls: string[] = [];
    const writes: Array<{ viewerSub: string; tombstone: GrantTombstone }> = [];
    let stored: LiveGrant | GrantTombstone | null = {
      viewerSub,
      email: 'viewer@example.com',
      collectionId,
      role: 'viewer',
      createdAt: 1,
      updatedAt: 2,
      active: true,
    };
    const deps: RevokeGrantDependencies = {
      runTransaction: async (work) => {
        calls.push('transaction');
        return work({
          readForwardGrant: async (requestedViewerSub) => {
            calls.push(`read:${requestedViewerSub}`);
            return stored;
          },
          writePair: async (requestedViewerSub, tombstone) => {
            calls.push(`write:${requestedViewerSub}`);
            writes.push({ viewerSub: requestedViewerSub, tombstone });
            stored = tombstone;
          },
        });
      },
    };

    // Owner revoke (calls orchestrateGrantRevoke exactly as `collectionGrantsRevokePost` does).
    const revoked = await orchestrateGrantRevoke(viewerSub, 9, deps);
    expect(revoked).toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });

    // Viewer leave (calls the identical function; `sharedLeavePost` reuses it).
    const left = await orchestrateGrantRevoke(viewerSub, 20, deps);
    expect(left).toEqual({
      kind: 'already',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });
    expect(writes).toHaveLength(1);
    expect(calls.filter((c) => c === 'transaction')).toHaveLength(2);
  });

  it('viewer leave then owner revoke: the second call finds it already gone', async () => {
    let stored: LiveGrant | GrantTombstone | null = {
      viewerSub,
      email: 'viewer@example.com',
      collectionId,
      role: 'viewer',
      createdAt: 1,
      updatedAt: 2,
      active: true,
    };
    const writes: Array<{ viewerSub: string; tombstone: GrantTombstone }> = [];
    const deps: RevokeGrantDependencies = {
      runTransaction: async (work) =>
        work({
          readForwardGrant: async () => stored,
          writePair: async (requestedViewerSub, tombstone) => {
            writes.push({ viewerSub: requestedViewerSub, tombstone });
            stored = tombstone;
          },
        }),
    };

    const left = await orchestrateGrantRevoke(viewerSub, 9, deps);
    expect(left).toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });

    const revoked = await orchestrateGrantRevoke(viewerSub, 20, deps);
    expect(revoked).toEqual({
      kind: 'already',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9, active: false },
    });
    expect(writes).toHaveLength(1);
  });
});

describe('collectionLiveForGrant', () => {
  it('matches isLiveDoc for collection reads', () => {
    expect(collectionLiveForGrant(undefined)).toBe(false);
    expect(collectionLiveForGrant({ updatedAt: 1 })).toBe(true);
    expect(collectionLiveForGrant({ updatedAt: 1, deletedAt: 2 })).toBe(false);
  });
});

describe('collection cascade tombstone decision', () => {
  it('accepts only an exact canonical tombstone at cascadeAt', () => {
    expect(canonicalCollectionTombstoneAt({ updatedAt: 100, deletedAt: 100 })).toBe(100);
    expect(
      collectionIsCanonicalTombstoneAt(
        { updatedAt: 100, deletedAt: 100 },
        100,
      ),
    ).toBe(true);
    expect(
      collectionIsCanonicalTombstoneAt(
        { updatedAt: 100, deletedAt: 100 },
        99,
      ),
    ).toBe(false);
  });

  it.each([
    undefined,
    {},
    { updatedAt: 100 },
    { updatedAt: 100, deletedAt: null },
    { updatedAt: 100, deletedAt: 99 },
    { updatedAt: Number.NaN, deletedAt: Number.NaN },
    { updatedAt: Number.POSITIVE_INFINITY, deletedAt: Number.POSITIVE_INFINITY },
  ])('rejects a missing, live, or malformed collection: %j', (collection) => {
    expect(canonicalCollectionTombstoneAt(collection)).toBeUndefined();
    expect(collectionIsCanonicalTombstoneAt(collection, 100)).toBe(false);
  });
});

describe('incomingShareCascadeDoc', () => {
  const ownerSub = 'owner';
  const cascadeAt = 100;

  it('tombstones when absent or updatedAt is at or before cascadeAt', () => {
    expect(incomingShareCascadeDoc(undefined, ownerSub, collectionId, cascadeAt)).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: cascadeAt },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: 50 },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
  });

  it('still tombstones a share whose updatedAt is after cascadeAt', () => {
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: cascadeAt + 1 },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
  });
});

describe('grantCascadeRevoke', () => {
  const cascadeAt = 100;
  const liveGrant: LiveGrant = {
    viewerSub,
    email: 'a@b.c',
    collectionId,
    role: 'viewer' as const,
    createdAt: 1,
    updatedAt: 50,
    active: true,
  };

  it('tombstones when absent or updatedAt is at or before cascadeAt', () => {
    expect(grantCascadeRevoke(null, viewerSub, cascadeAt)).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
      active: false,
    });
    expect(grantCascadeRevoke(liveGrant, viewerSub, cascadeAt)).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
      active: false,
    });
    expect(
      grantCascadeRevoke(
        { viewerSub, updatedAt: cascadeAt, deletedAt: cascadeAt, active: false },
        viewerSub,
        cascadeAt,
      ),
    ).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
      active: false,
    });
  });

  it('still tombstones a live grant whose updatedAt is after cascadeAt', () => {
    expect(
      grantCascadeRevoke(
        { ...liveGrant, updatedAt: cascadeAt + 1 },
        viewerSub,
        cascadeAt,
      ),
    ).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
      active: false,
    });
  });
});

describe('cascadeGrantPairTransition', () => {
  const ownerSub = 'owner';
  const cascadeAt = 100;
  const tombstone = {
    grant: { viewerSub, updatedAt: cascadeAt, deletedAt: cascadeAt, active: false },
    share: {
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    },
  };

  it('tombstones both sides when neither doc is newer than cascadeAt', () => {
    const result = cascadeGrantPairTransition({
      existingGrant: {
        viewerSub,
        email: 'a@b.c',
        collectionId,
        role: 'viewer' as const,
        createdAt: 1,
        updatedAt: 50,
        active: true,
      },
      existingShare: { ownerSub, collectionId, updatedAt: 50 },
      viewerSub,
      ownerSub,
      collectionId,
      cascadeAt,
    });
    expect(result).toEqual(tombstone);
  });

  it('still tombstones both when either side is newer than cascadeAt', () => {
    expect(
      cascadeGrantPairTransition({
        existingGrant: {
          viewerSub,
          email: 'a@b.c',
          collectionId,
          role: 'viewer' as const,
          createdAt: 1,
          updatedAt: cascadeAt + 1,
          active: true,
        },
        existingShare: { ownerSub, collectionId, updatedAt: 50 },
        viewerSub,
        ownerSub,
        collectionId,
        cascadeAt,
      }),
    ).toEqual(tombstone);
    expect(
      cascadeGrantPairTransition({
        existingGrant: null,
        existingShare: { ownerSub, collectionId, updatedAt: cascadeAt + 1 },
        viewerSub,
        ownerSub,
        collectionId,
        cascadeAt,
      }),
    ).toEqual(tombstone);
  });
});

describe('parseIncomingShareDoc', () => {
  it('parses a stored incoming share', () => {
    expect(
      parseIncomingShareDoc({
        ownerSub: 'owner',
        collectionId,
        updatedAt: 3,
        ownerEmail: 'o@e.c',
      }),
    ).toEqual({
      ownerSub: 'owner',
      collectionId,
      updatedAt: 3,
      ownerEmail: 'o@e.c',
    });
  });
});

describe('sessionCanViewOwnerPhoto', () => {
  it('allows live cover and gallery photos and bounds reads for an authorized first candidate', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner', collectionId },
      {
        grantId: 'grant-b',
        ownerSub: 'owner',
        collectionId: secondCollectionId,
      },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, [recipeId]),
      ],
      [
        docKey('owner', 'photos', 'photo-cover'),
        livePhoto(recipeId),
      ],
      [
        docKey('owner', 'photos', 'photo-gallery'),
        { ...livePhoto(recipeId), id: 'photo-gallery' },
      ],
      [
        docKey('owner', 'recipes', recipeId),
        liveRecipe(recipeId, {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-gallery'],
        }),
      ],
      [
        docKey('owner', 'collections', secondCollectionId),
        liveCollection(secondCollectionId, [secondRecipeId]),
      ],
      [
        docKey('owner', 'recipes', secondRecipeId),
        liveRecipe(secondRecipeId, { photoId: 'photo-cover' }),
      ],
    ]);
    const coverCalls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares,
          docs,
          calls: coverCalls,
          photoId: 'photo-cover',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({ shares, docs, photoId: 'photo-gallery' }),
      ),
    ).resolves.toBe(true);
    expect(coverCalls[0]).toBe(`list:${viewerSub}`);
    expect(coverCalls).toContain(`share:${viewerSub}:grant-a`);
    expect(coverCalls).not.toContain(`share:${viewerSub}:grant-b`);
    expect(coverCalls).not.toContain(
      `doc:owner:collections:${secondCollectionId}`,
    );
    expect(coverCalls.filter((call) => call.startsWith('share:'))).toHaveLength(1);
    expect(
      coverCalls.filter((call) => call.includes(':collections:')),
    ).toHaveLength(1);
    expect(coverCalls.filter((call) => call.includes(':photos:'))).toHaveLength(1);
    expect(coverCalls.filter((call) => call.includes(':recipes:'))).toHaveLength(1);
  });

  it('denies a freshly revoked or changed share before owner reads', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    for (const current of [
      undefined,
      { ...share, collectionId: secondCollectionId },
    ]) {
      const calls: string[] = [];
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({
            shares: [share],
            current: new Map([['grant-a', current]]),
            calls,
          }),
        ),
      ).resolves.toBe(false);
      expect(calls).toEqual([
        `list:${viewerSub}`,
        `share:${viewerSub}:grant-a`,
      ]);
    }
  });

  it('denies through a missing, tombstoned, or mismatched collection without reading photo metadata', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      undefined,
      { ...liveCollection(collectionId, [recipeId]), deletedAt: 3 },
      liveCollection(secondCollectionId, [recipeId]),
    ];
    for (const collection of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [docKey('owner', 'collections', collectionId), collection],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.some((call) => call.includes(':photos:'))).toBe(false);
      expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    }
  });

  it('denies missing, tombstoned, non-live, or invalid-parent photo metadata before a recipe read', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      undefined,
      { ...livePhoto(recipeId), deletedAt: 3 },
      { ...livePhoto(recipeId), status: 'uploading' },
      livePhoto('not-a-valid-recipe-id'),
    ];
    for (const photo of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [
          docKey('owner', 'collections', collectionId),
          liveCollection(collectionId, [recipeId]),
        ],
        [docKey('owner', 'photos', 'photo-target'), photo],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.filter((call) => call.includes(':photos:'))).toHaveLength(1);
      expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    }
  });

  it('denies a missing or tombstoned recipe and a recipe removed from the collection', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      {
        collection: liveCollection(collectionId, [recipeId]),
        recipe: undefined,
      },
      {
        collection: liveCollection(collectionId, [recipeId]),
        recipe: {
          ...liveRecipe(recipeId, { photoId: 'photo-target' }),
          deletedAt: 3,
        },
      },
      {
        collection: liveCollection(collectionId, [secondRecipeId]),
        recipe: liveRecipe(recipeId, { photoId: 'photo-target' }),
      },
    ];
    for (const candidate of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [docKey('owner', 'collections', collectionId), candidate.collection],
        [docKey('owner', 'photos', 'photo-target'), livePhoto(recipeId)],
        [docKey('owner', 'recipes', recipeId), candidate.recipe],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.filter((call) => call.includes(':recipes:'))).toHaveLength(1);
    }
  });

  it('denies every photo of an owner who is no longer admitted, before owner reads', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner', collectionId },
      { grantId: 'grant-b', ownerSub: 'owner', collectionId: secondCollectionId },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, [recipeId]),
      ],
      [docKey('owner', 'photos', 'photo-target'), livePhoto(recipeId)],
      [
        docKey('owner', 'recipes', recipeId),
        liveRecipe(recipeId, { photoId: 'photo-target' }),
      ],
    ]);
    const calls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares,
          docs,
          calls,
          ownerAdmitted: async () => false,
        }),
      ),
    ).resolves.toBe(false);
    expect(calls.filter((call) => call.startsWith('owner:'))).toEqual(['owner:owner']);
    expect(calls.some((call) => call.startsWith('doc:'))).toBe(false);
  });

  it('propagates unknown owner membership so the route answers 503', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares: [share],
          ownerAdmitted: async () => {
            throw new Error('firestore blip');
          },
        }),
      ),
    ).rejects.toThrow('firestore blip');
  });

  it('denies unrelated owner photos and chat attachments despite parent metadata', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, [recipeId]),
      ],
      [
        docKey('owner', 'recipes', recipeId),
        liveRecipe(recipeId, {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-gallery'],
        }),
      ],
      [
        docKey('owner', 'photos', 'photo-unrelated'),
        { ...livePhoto(recipeId), id: 'photo-unrelated' },
      ],
      [
        docKey('owner', 'photos', 'photo-chat'),
        { ...livePhoto(recipeId), id: 'photo-chat' },
      ],
    ]);
    for (const photoId of ['photo-unrelated', 'photo-chat']) {
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, photoId }),
        ),
      ).resolves.toBe(false);
    }
  });
});

describe('collection delete grant cascade', () => {
  const ownerSub = 'owner';
  const otherViewer = 'viewer-2';

  type Mem = {
    gen: number;
    collection: Record<string, unknown> | undefined;
    grants: Map<string, Record<string, unknown>>;
    shares: Map<string, Record<string, unknown>>;
  };

  function liveForward(viewer: string, updatedAt: number): Record<string, unknown> {
    return {
      viewerSub: viewer,
      email: `${viewer}@example.com`,
      collectionId,
      role: 'viewer' as const,
      createdAt: 1,
      updatedAt,
      active: true,
    };
  }

  function liveShare(updatedAt: number): Record<string, unknown> {
    return {
      ownerSub,
      collectionId,
      ownerEmail: 'owner@example.com',
      updatedAt,
    };
  }

  function emptyMem(
    collection: Record<string, unknown> | undefined,
  ): Mem {
    return { gen: 1, collection, grants: new Map(), shares: new Map() };
  }

  function readsBeforeWrites(events: string[]): void {
    let lastRead = -1;
    let firstWrite = -1;
    events.forEach((event, index) => {
      if (event.startsWith('read') || event.startsWith('query')) {
        lastRead = index;
      }
      if (event.startsWith('write') && firstWrite === -1) {
        firstWrite = index;
      }
    });
    if (firstWrite !== -1) {
      expect(lastRead).toBeGreaterThanOrEqual(0);
      expect(lastRead).toBeLessThan(firstWrite);
    }
  }

  function deleteTx(mem: Mem, events: string[]): CollectionGrantDeleteTransaction {
    let writing = false;
    return {
      readCollection: async () => {
        if (writing) {
          throw new Error('read after write');
        }
        events.push('readCollection');
        return mem.collection;
      },
      queryLiveForwardGrants: async () => {
        if (writing) {
          throw new Error('read after write');
        }
        events.push('queryLiveGrants');
        const docs: Array<{ viewerSub: string; data: Record<string, unknown> }> = [];
        for (const [viewer, data] of mem.grants) {
          if (data.active === true) {
            docs.push({ viewerSub: viewer, data: { ...data } });
          }
        }
        return docs;
      },
      readReverseShare: async (viewer) => {
        if (writing) {
          throw new Error('read after write');
        }
        events.push(`readShare:${viewer}`);
        const share = mem.shares.get(viewer);
        return share === undefined ? undefined : { ...share };
      },
      writeCollection: (doc) => {
        writing = true;
        events.push('writeCollection');
        mem.collection = { ...doc };
      },
      writePair: (viewer, grant, share) => {
        writing = true;
        events.push(`writePair:${viewer}`);
        mem.grants.set(viewer, { ...grant });
        mem.shares.set(viewer, { ...share });
      },
    };
  }

  function grantAddTx(mem: Mem, events: string[]): GrantAddTransaction {
    let writing = false;
    return {
      readCollection: async () => {
        if (writing) {
          throw new Error('read after write');
        }
        events.push('readCollection');
        return mem.collection;
      },
      readForwardGrants: async () => {
        if (writing) {
          throw new Error('read after write');
        }
        events.push('readGrants');
        return [...mem.grants].map(([id, data]) => ({ id, data: { ...data } }));
      },
      writePair: (grant, share) => {
        writing = true;
        events.push('writePair');
        mem.grants.set(grant.viewerSub, { ...grant });
        mem.shares.set(grant.viewerSub, { ...share });
      },
    };
  }

  it('revokes a live pair at a server order after the client clock', async () => {
    const mem = emptyMem({ id: collectionId, updatedAt: 50 });
    mem.grants.set(viewerSub, liveForward(viewerSub, 250));
    mem.grants.set(otherViewer, liveForward(otherViewer, 10));
    mem.shares.set(viewerSub, liveShare(250));
    mem.shares.set(otherViewer, liveShare(10));
    const events: string[] = [];
    let transactions = 0;
    const result = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) => {
          transactions += 1;
          return work(deleteTx(mem, events));
        },
      },
    );

    expect(transactions).toBe(1);
    expect(result).toEqual({ applied: true, serverUpdatedAt: 80 });
    readsBeforeWrites(events);
    expect(events.filter((event) => event.startsWith('write'))[0]).toBe('writeCollection');
    expect(mem.collection).toEqual({
      id: collectionId,
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 80,
      grantCascadeAt: 251,
    });
    for (const viewer of [viewerSub, otherViewer]) {
      expect(mem.grants.get(viewer)).toEqual({
        viewerSub: viewer,
        updatedAt: 251,
        deletedAt: 251,
        active: false,
      });
      expect(mem.shares.get(viewer)).toEqual({
        ownerSub,
        collectionId,
        updatedAt: 251,
        deletedAt: 251,
      });
    }
  });

  it('bounds the live-grant query inside one read-before-write transaction', async () => {
    const events: string[] = [];
    const extra = LIVE_GRANT_QUERY_LIMIT + 4;
    const queried = Array.from({ length: extra }, (_, index) => ({
      viewerSub: `viewer-${index}`,
      data: liveForward(`viewer-${index}`, 400 + index),
    }));
    const writes: string[] = [];
    await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) =>
          work({
            readCollection: async () => {
              events.push('readCollection');
              return { updatedAt: 50 };
            },
            queryLiveForwardGrants: async () => {
              events.push('queryLiveGrants');
              return queried;
            },
            readReverseShare: async (viewer) => {
              events.push(`readShare:${viewer}`);
              return liveShare(500);
            },
            writeCollection: () => {
              events.push('writeCollection');
            },
            writePair: (viewer) => {
              events.push(`writePair:${viewer}`);
              writes.push(viewer);
            },
          }),
      },
    );
    readsBeforeWrites(events);
    expect(writes).toHaveLength(LIVE_GRANT_QUERY_LIMIT);
    expect(events.indexOf('writeCollection')).toBeGreaterThan(
      events.lastIndexOf('readShare:viewer-0') ,
    );
  });

  it('heals a stored tombstone at grantCascadeAt, not the stale request', async () => {
    const stored = {
      id: collectionId,
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 80,
      grantCascadeAt: 900,
    };
    const mem = emptyMem(stored);
    mem.grants.set(viewerSub, liveForward(viewerSub, 950));
    mem.shares.set(viewerSub, liveShare(950));
    const events: string[] = [];
    const result = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 40 },
      {
        now: () => 5_000,
        runTransaction: async (work) => work(deleteTx(mem, events)),
      },
    );
    expect(result).toEqual({ applied: false, current: stored });
    expect(events).not.toContain('writeCollection');
    readsBeforeWrites(events);
    expect(mem.collection).toEqual(stored);
    expect(mem.grants.get(viewerSub)).toMatchObject({
      updatedAt: 900,
      deletedAt: 900,
      active: false,
    });
    expect(mem.shares.get(viewerSub)).toMatchObject({
      updatedAt: 900,
      deletedAt: 900,
    });
  });

  it('rewrites an equal client clock without replacing the stored cascade order', async () => {
    const mem = emptyMem({
      id: collectionId,
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 80,
      grantCascadeAt: 900,
    });
    mem.grants.set(viewerSub, liveForward(viewerSub, 250));
    mem.shares.set(viewerSub, liveShare(250));
    const result = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 5_000,
        runTransaction: async (work) => work(deleteTx(mem, [])),
      },
    );
    expect(result).toEqual({ applied: true, serverUpdatedAt: 5_000 });
    expect(mem.collection).toEqual({
      id: collectionId,
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 5_000,
      grantCascadeAt: 900,
    });
    expect(mem.grants.get(viewerSub)).toMatchObject({
      updatedAt: 900,
      deletedAt: 900,
      active: false,
    });
  });

  it('performs no ACL writes for a stale delete of a newer live collection', async () => {
    const current = { id: collectionId, updatedAt: 200 };
    const mem = emptyMem(current);
    mem.grants.set(viewerSub, liveForward(viewerSub, 50));
    mem.shares.set(viewerSub, liveShare(50));
    const events: string[] = [];
    const result = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 5_000,
        runTransaction: async (work) => work(deleteTx(mem, events)),
      },
    );
    expect(result).toEqual({ applied: false, current });
    expect(events).toEqual(['readCollection']);
    expect(mem.grants.get(viewerSub)).toMatchObject({ active: true, updatedAt: 50 });
    expect(mem.shares.get(viewerSub)).toEqual(liveShare(50));
  });

  it('keeps missing and malformed collections from revoking grants', async () => {
    const missing = emptyMem(undefined);
    missing.grants.set(viewerSub, liveForward(viewerSub, 50));
    const missingEvents: string[] = [];
    const missingResult = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) => work(deleteTx(missing, missingEvents)),
      },
    );
    expect(missingResult).toEqual({ applied: true, serverUpdatedAt: 80 });
    expect(missing.collection).toEqual({
      id: collectionId,
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 80,
    });
    expect(missing.collection).not.toHaveProperty('grantCascadeAt');
    expect(missingEvents).toEqual(['readCollection', 'writeCollection']);
    expect(missing.grants.get(viewerSub)).toMatchObject({ active: true });

    const malformed = { updatedAt: 200, deletedAt: 199 };
    const stale = emptyMem(malformed);
    stale.grants.set(viewerSub, liveForward(viewerSub, 50));
    const staleEvents: string[] = [];
    const staleResult = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) => work(deleteTx(stale, staleEvents)),
      },
    );
    expect(staleResult).toEqual({ applied: false, current: malformed });
    expect(staleEvents).toEqual(['readCollection']);
    expect(stale.grants.get(viewerSub)).toMatchObject({ active: true });

    const repair = emptyMem({ updatedAt: 50, deletedAt: 40 });
    repair.grants.set(viewerSub, liveForward(viewerSub, 50));
    const repairEvents: string[] = [];
    const repairResult = await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) => work(deleteTx(repair, repairEvents)),
      },
    );
    expect(repairResult).toEqual({ applied: true, serverUpdatedAt: 80 });
    expect(repair.collection).not.toHaveProperty('grantCascadeAt');
    expect(repairEvents).toEqual(['readCollection', 'writeCollection']);
    expect(repair.grants.get(viewerSub)).toMatchObject({ active: true });
  });

  describe('public link revoke (deleteRevokingPublicLinks)', () => {
    function deleteWithPublicLink(mem: Mem, events: string[]) {
      const links = { live: ['public-link'], revoked: [] as string[] };
      const io = {
        readLive: async () => {
          events.push('readPublicLinks');
          return [...links.live];
        },
        writeRevoked: (rows: string[]) => {
          events.push('writePublicLinks');
          links.revoked.push(...rows);
          links.live = links.live.filter((row) => !rows.includes(row));
        },
      };
      const run = (clientUpdatedAt: number) =>
        orchestrateCollectionGrantDelete(
          { ownerSub, collectionId, clientUpdatedAt },
          {
            now: () => 5_000,
            runTransaction: (work) =>
              deleteRevokingPublicLinks(io, () => work(deleteTx(mem, events))),
          },
        );
      return { links, run };
    }

    it('revokes the live link when a live collection is deleted, reading it first', async () => {
      const mem = emptyMem({ id: collectionId, updatedAt: 50 });
      mem.grants.set(viewerSub, liveForward(viewerSub, 40));
      mem.shares.set(viewerSub, liveShare(40));
      const events: string[] = [];
      const { links, run } = deleteWithPublicLink(mem, events);
      const result = await run(100);
      expect(result).toEqual({ applied: true, serverUpdatedAt: 5_000 });
      expect(links).toEqual({ live: [], revoked: ['public-link'] });
      expect(events[0]).toBe('readPublicLinks');
      expect(events.at(-1)).toBe('writePublicLinks');
      readsBeforeWrites(events);
    });

    it('revokes on a first tombstone with no stored collection state', async () => {
      const mem = emptyMem(undefined);
      const events: string[] = [];
      const { links, run } = deleteWithPublicLink(mem, events);
      expect(await run(100)).toEqual({ applied: true, serverUpdatedAt: 5_000 });
      expect(links.revoked).toEqual(['public-link']);
    });

    it('leaves the link live when a stale delete loses to a newer live collection', async () => {
      const current = { id: collectionId, updatedAt: 200 };
      const mem = emptyMem(current);
      const events: string[] = [];
      const { links, run } = deleteWithPublicLink(mem, events);
      expect(await run(100)).toEqual({ applied: false, current });
      expect(links).toEqual({ live: ['public-link'], revoked: [] });
      expect(events).not.toContain('writePublicLinks');
    });

    it('writes nothing for a heal that does not apply: the first delete already revoked', async () => {
      const stored = {
        id: collectionId,
        updatedAt: 100,
        deletedAt: 100,
        serverUpdatedAt: 80,
        grantCascadeAt: 900,
      };
      const mem = emptyMem(stored);
      const events: string[] = [];
      const { links, run } = deleteWithPublicLink(mem, events);
      expect(await run(40)).toEqual({ applied: false, current: stored });
      expect(events).not.toContain('writePublicLinks');
      expect(links.revoked).toEqual([]);
    });
  });

  it('does not revive an old share on undelete, and a later grant add can', async () => {
    const mem = emptyMem({ id: collectionId, updatedAt: 50 });
    mem.grants.set(viewerSub, liveForward(viewerSub, 250));
    mem.shares.set(viewerSub, liveShare(250));
    await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: async (work) => work(deleteTx(mem, [])),
      },
    );
    mem.collection = {
      id: collectionId,
      name: 'Dinners',
      recipeIds: [],
      updatedAt: 2_000,
    };
    expect(mem.grants.get(viewerSub)).toMatchObject({ active: false, deletedAt: 251 });
    expect(mem.shares.get(viewerSub)).toMatchObject({ deletedAt: 251 });

    const addEvents: string[] = [];
    const added = await orchestrateGrantAdd(
      {
        ownerSub,
        ownerEmail: 'owner@example.com',
        collectionId,
        viewerSub,
        email: 'viewer-1@example.com',
        role: 'editor',
        onExisting: 'applyRole',
      },
      {
        now: () => 3_000,
        runTransaction: async (work) => work(grantAddTx(mem, addEvents)),
      },
    );
    readsBeforeWrites(addEvents);
    expect(addEvents.indexOf('readCollection')).toBeLessThan(addEvents.indexOf('writePair'));
    expect(added.kind).toBe('write');
    expect(mem.grants.get(viewerSub)).toMatchObject({
      active: true,
      role: 'editor',
      updatedAt: 3_000,
    });
    expect(mem.grants.get(viewerSub)).not.toHaveProperty('deletedAt');
    expect(mem.shares.get(viewerSub)).toEqual({
      ownerSub,
      collectionId,
      ownerEmail: 'owner@example.com',
      role: 'editor',
      updatedAt: 3_000,
    });
    expect(mem.shares.get(viewerSub)).not.toHaveProperty('deletedAt');
  });

  it('retries so a grant add and a collection delete cannot both stay live', async () => {
    function optimisticDelete<T>(
      mem: Mem,
      attempts: string[][],
      beforeCommit?: () => void,
    ) {
      let stolen = false;
      return async (
        work: (tx: CollectionGrantDeleteTransaction) => Promise<T>,
      ): Promise<T> => {
        while (true) {
          const seen = mem.gen;
          const events: string[] = [];
          attempts.push(events);
          const ops: Array<() => void> = [];
          let writing = false;
          const result = await work({
            readCollection: async () => {
              if (writing) {
                throw new Error('read after write');
              }
              events.push('readCollection');
              return mem.collection;
            },
            queryLiveForwardGrants: async () => {
              if (writing) {
                throw new Error('read after write');
              }
              events.push('queryLiveGrants');
              const docs = [];
              for (const [viewer, data] of mem.grants) {
                if (data.active === true) {
                  docs.push({ viewerSub: viewer, data: { ...data } });
                }
              }
              return docs;
            },
            readReverseShare: async (viewer) => {
              if (writing) {
                throw new Error('read after write');
              }
              events.push(`readShare:${viewer}`);
              const share = mem.shares.get(viewer);
              return share === undefined ? undefined : { ...share };
            },
            writeCollection: (doc) => {
              writing = true;
              events.push('writeCollection');
              ops.push(() => {
                mem.collection = { ...doc };
              });
            },
            writePair: (viewer, grant, share) => {
              writing = true;
              events.push(`writePair:${viewer}`);
              ops.push(() => {
                mem.grants.set(viewer, { ...grant });
                mem.shares.set(viewer, { ...share });
              });
            },
          });
          if (!stolen && beforeCommit) {
            stolen = true;
            beforeCommit();
            mem.gen += 1;
            continue;
          }
          if (mem.gen !== seen) {
            continue;
          }
          for (const op of ops) {
            op();
          }
          if (ops.length > 0) {
            mem.gen += 1;
          }
          return result;
        }
      };
    }

    function optimisticAdd<T>(
      mem: Mem,
      attempts: string[][],
      beforeCommit?: () => void,
    ) {
      let stolen = false;
      return async (work: (tx: GrantAddTransaction) => Promise<T>): Promise<T> => {
        while (true) {
          const seen = mem.gen;
          const events: string[] = [];
          attempts.push(events);
          const ops: Array<() => void> = [];
          let writing = false;
          const result = await work({
            readCollection: async () => {
              if (writing) {
                throw new Error('read after write');
              }
              events.push('readCollection');
              return mem.collection;
            },
            readForwardGrants: async () => {
              if (writing) {
                throw new Error('read after write');
              }
              events.push('readGrants');
              return [...mem.grants].map(([id, data]) => ({ id, data: { ...data } }));
            },
            writePair: (grant, share) => {
              writing = true;
              events.push('writePair');
              ops.push(() => {
                mem.grants.set(grant.viewerSub, { ...grant });
                mem.shares.set(grant.viewerSub, { ...share });
              });
            },
          });
          if (!stolen && beforeCommit) {
            stolen = true;
            beforeCommit();
            mem.gen += 1;
            continue;
          }
          if (mem.gen !== seen) {
            continue;
          }
          for (const op of ops) {
            op();
          }
          if (ops.length > 0) {
            mem.gen += 1;
          }
          return result;
        }
      };
    }

    const afterDelete = emptyMem({ id: collectionId, updatedAt: 50 });
    const addAttempts: string[][] = [];
    const addOutcome = await orchestrateGrantAdd(
      {
        ownerSub,
        ownerEmail: 'owner@example.com',
        collectionId,
        viewerSub,
        email: 'viewer-1@example.com',
        role: 'viewer',
        onExisting: 'applyRole',
      },
      {
        now: () => 3_000,
        runTransaction: optimisticAdd(afterDelete, addAttempts, () => {
          afterDelete.collection = {
            id: collectionId,
            updatedAt: 100,
            deletedAt: 100,
            grantCascadeAt: 251,
          };
        }),
      },
    );
    expect(addOutcome).toEqual({ kind: 'collectionMissing' });
    expect(afterDelete.grants.size).toBe(0);
    expect(afterDelete.collection).toMatchObject({ deletedAt: 100 });
    for (const attempt of addAttempts) {
      readsBeforeWrites(attempt);
      expect(attempt[0]).toBe('readCollection');
    }
    expect(addAttempts[0]?.some((event) => event.startsWith('write'))).toBe(true);
    expect(addAttempts[1]?.some((event) => event.startsWith('write'))).toBe(false);

    const afterAdd = emptyMem({ id: collectionId, updatedAt: 50 });
    const deleteAttempts: string[][] = [];
    await orchestrateCollectionGrantDelete(
      { ownerSub, collectionId, clientUpdatedAt: 100 },
      {
        now: () => 80,
        runTransaction: optimisticDelete(afterAdd, deleteAttempts, () => {
          afterAdd.grants.set(viewerSub, liveForward(viewerSub, 300));
          afterAdd.shares.set(viewerSub, liveShare(300));
        }),
      },
    );
    expect(afterAdd.collection).toMatchObject({
      updatedAt: 100,
      deletedAt: 100,
    });
    expect(afterAdd.collection?.grantCascadeAt).not.toBe(100);
    expect(afterAdd.grants.get(viewerSub)).toMatchObject({ active: false });
    expect(afterAdd.shares.get(viewerSub)).toMatchObject({ deletedAt: expect.any(Number) });
    for (const attempt of deleteAttempts) {
      readsBeforeWrites(attempt);
      expect(attempt[0]).toBe('readCollection');
    }
  });
});
