import {randomUUID} from 'node:crypto';
import {normalizeGameIdSelector} from './parser.js';

/** Read the old single-account format without discarding its encrypted session. */
export function accountBindings(saved) {
  if (Array.isArray(saved?.accounts)) return {...saved, version: 2, accounts: saved.accounts};
  return {version: 2, accounts: saved?.state ? [{id: 'legacy', state: saved.state, savedAt: saved.savedAt, gameIds: []}] : []};
}

const name = profile => normalizeGameIdSelector(profile.playerName || `${profile.gameId}${profile.tag}`);
export function normalizeAccountProfiles(profiles) {
  return profiles.map(profile => {
    const playerName = name(profile);
    const [gameId, tag] = playerName.split('#');
    return {...profile, playerName, gameId, tag: `#${tag}`};
  });
}
export function sameAccount(account, state, gameIds) {
  const sessions = cookies => (cookies ?? []).filter(cookie => ['sid', 'PHPSESSID'].includes(cookie.name) && cookie.value);
  if (sessions(account.state?.cookies).some(old => sessions(state.cookies).some(cookie => cookie.name === old.name && cookie.value === old.value))) return true;
  return (account.gameIds ?? []).some(old => gameIds.some(profile =>
    (old.id && profile.id && old.id === profile.id) || name(old) === name(profile)));
}

/** Keep insertion order when refreshing a login, including after a profile rename. */
export function mergeAccount(bindings, state, gameIds, savedAt = Date.now()) {
  const matches = bindings.accounts.filter(account => sameAccount(account, state, gameIds));
  const refreshed = {id: matches[0]?.id ?? randomUUID(), state, savedAt, gameIds};
  if (!matches.length) return {...bindings, version: 2, accounts: [...bindings.accounts, refreshed]};
  return {...bindings, version: 2, accounts: bindings.accounts.flatMap(account =>
    account === matches[0] ? [refreshed] : matches.includes(account) ? [] : [account])};
}
