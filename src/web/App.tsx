import { useEffect, useRef } from 'react';
import { BuyList } from './BuyList';
import { Dashboard } from './Dashboard';
import { Donors } from './Donors';
import { Enrich } from './Enrich';
import { ImportPage } from './ImportPage';
import { Locations } from './Locations';
import { PartDetail } from './PartDetail';
import { Parts } from './Parts';
import { Projects } from './Projects';
import { Settings } from './Settings';
import { Suppliers } from './Suppliers';
import { useRoute } from './route';

const NAV = [
  ['/', 'Dashboard'], ['/parts', 'Parts'], ['/projects', 'Projects'], ['/buy', 'Buy list'], ['/salvage', 'Salvage'],
  ['/suppliers', 'Suppliers'], ['/locations', 'Locations'], ['/import', 'Import'], ['/enrich', 'Enrich'], ['/settings', 'Settings'],
] as const;

export function App() {
  const { path } = useRoute();
  // Jump to the top when you move to another page, but not when only the filters in the URL change.
  const last = useRef(path);
  useEffect(() => { if (last.current !== path) { window.scrollTo(0, 0); last.current = path; } }, [path]);

  const part = /^\/parts\/(\d+)$/.exec(path);
  const proj = /^\/projects\/(\d+)$/.exec(path);
  // Parts fills the window and scrolls inside itself; every other page is a normal document.
  const fills = path === '/parts';
  const wideDoc = path === '/buy' || path === '/suppliers';
  const page = part ? <PartDetail key={part[1]} id={Number(part[1])} />
    : path === '/parts' ? <Parts />
    : proj ? <Projects key={proj[1]} projectId={Number(proj[1])} />
    : path === '/projects' ? <Projects projectId={null} />
    : path === '/buy' ? <BuyList />
    : path === '/suppliers' ? <Suppliers />
    : path === '/salvage' ? <Donors />
    : path === '/locations' ? <Locations />
    : path === '/import' ? <ImportPage />
    : path === '/enrich' ? <Enrich />
    : path === '/settings' ? <Settings />
    : <Dashboard />;
  // The dashboard spreads into three columns on an ultrawide screen, so it is not capped at 1500px either.
  const fluid = wideDoc || page.type === Dashboard;
  const active = part ? '/parts' : proj ? '/projects' : NAV.find(([h]) => h === path)?.[0] ?? '/';
  // On a narrow screen the tab bar scrolls sideways; keep the current tab in view.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { nav.current?.querySelector('a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [active]);
  return (
    <>
      {/* LCSC's two-tier header: a deep-blue system bar (hidden on a phone) over the tab bar. */}
      <header className="appbar">
        <div className="sysbar"><b>partlib</b><span>Parts inventory and purchasing</span></div>
        <nav ref={nav}>{NAV.map(([h, label]) => <a key={h} href={`#${h}`} className={h === active ? 'on' : ''}>{label}</a>)}</nav>
      </header>
      {fills ? <div className="fill">{page}</div> : <main className={fluid ? 'fluid' : ''}>{page}</main>}
    </>
  );
}
