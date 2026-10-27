import type {Repository} from './repository';
/** AI data and quota remain account-owned; only the reading-school check follows
 * this request's authenticated browser workspace. No account profile is changed. */
export function guestAiRepository(repo:Repository,accountOwner:string,guestOwner:string):Repository{
 return{...repo,selectedSchool:owner=>repo.selectedSchool(owner===accountOwner?guestOwner:owner)};
}
