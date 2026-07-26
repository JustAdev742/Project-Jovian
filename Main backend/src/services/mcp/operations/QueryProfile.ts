import { buildAthenaProfile } from '../profiles/athena';
import { buildCommonCoreProfile, buildCommonPublicProfile, buildCampaignProfile, buildMetadataProfile, buildStubProfile } from '../profiles/common_core';

/** QueryProfile — returns the full profile update. This is THE critical operation for lobby stability. */
export function handleQueryProfile(accountId: string, profileId: string, rvn: number): any {
  const now = new Date().toISOString();
  let profile: any;

  switch (profileId) {
    case 'athena':
      profile = buildAthenaProfile(accountId);
      break;
    case 'common_core':
      profile = buildCommonCoreProfile(accountId);
      break;
    case 'common_public':
      profile = buildCommonPublicProfile(accountId);
      break;
    // profile0 is the Save-the-World/campaign profile id, NOT an athena alias. Serving the athena
    // blob under it made the client store BR cosmetics in its campaign slot.
    case 'campaign':
    case 'profile0':
      profile = buildCampaignProfile(accountId);
      break;
    case 'metadata':
      profile = buildMetadataProfile(accountId);
      break;
    case 'creative':
    case 'collections':
    case 'collection_book_schematics0':
    case 'collection_book_people0':
    case 'theater0':
    case 'outpost0':
      profile = buildStubProfile(accountId, profileId);
      break;
    default:
      // Return empty profile for any unknown profileId to prevent crashes
      profile = buildStubProfile(accountId, profileId);
  }

  // The base revision is the PROFILE's revision, never the client's query rvn. Taking it from the
  // client produced envelopes with profileChangesBaseRevision > profileRevision (illegal), which
  // makes the client's cached revision oscillate.
  const profileRevision = profile.rvn || 1;

  return {
    profileRevision,
    profileId,
    profileChangesBaseRevision: profileRevision,
    profileChanges: [{ changeType: 'fullProfileUpdate', profile }],
    profileCommandRevision: profile.commandRevision || 1,
    serverTime: now,
    responseVersion: 1,
  };
}
