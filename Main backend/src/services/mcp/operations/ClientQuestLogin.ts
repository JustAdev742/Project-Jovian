/** ClientQuestLogin — called on lobby entry. Must return valid empty response. */
export function handleClientQuestLogin(accountId: string, profileId: string, rvn: number): any {
  return {
    profileRevision: rvn || 1,
    profileId,
    profileChangesBaseRevision: rvn || 1,
    profileChanges: [],
    profileCommandRevision: rvn || 1,
    serverTime: new Date().toISOString(),
    responseVersion: 1,
  };
}
