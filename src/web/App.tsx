import { useEffect, useState } from 'react';
import { Dashboard } from './Dashboard';
import { Donors } from './Donors';
import { ImportLcsc } from './ImportLcsc';
import { Locations } from './Locations';
import { PartDetail } from './PartDetail';
import { Parts } from './Parts';

const NAV = [
  ['#/', 'Dashboard'], ['#/parts', 'Parts'], ['#/salvage', 'Salvage'], ['#/locations', 'Locations'], ['#/import', 'Import LCSC'],
] as const;

function useHash(): string {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => { setH(location.hash || '#/'); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

export function App() {
  const hash = useHash();
  const part = /^#\/parts\/(\d+)$/.exec(hash);
  const page = part ? <PartDetail key={part[1]} id={Number(part[1])} />
    : hash === '#/parts' ? <Parts />
    : hash === '#/salvage' ? <Donors />
    : hash === '#/locations' ? <Locations />
    : hash === '#/import' ? <ImportLcsc />
    : <Dashboard />;
  const active = part ? '#/parts' : NAV.find(([h]) => h === hash)?.[0] ?? '#/';
  return (
    <>
      <nav>{NAV.map(([h, label]) => <a key={h} href={h} className={h === active ? 'on' : ''}>{label}</a>)}</nav>
      <main>{page}</main>
    </>
  );
}
