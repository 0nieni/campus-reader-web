import type { School } from '@campus/contracts';

/** Keep the directory order, placing BJTU immediately before BFSU for every picker. */
export function schoolsForDisplay(schools: readonly School[]): School[] {
  const ordered = [...schools];
  const bjtu = ordered.findIndex(school => school.id === 'bjtu');
  if (bjtu < 0 || !ordered.some(school => school.id === 'school_016')) return ordered;
  const [school] = ordered.splice(bjtu, 1);
  const bfsu = ordered.findIndex(school => school.id === 'school_016');
  ordered.splice(bfsu, 0, school!);
  return ordered;
}
