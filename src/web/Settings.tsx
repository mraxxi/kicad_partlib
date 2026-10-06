import { clearSaved, setPrefs, usePrefs, type Prefs } from './prefs';
import { SpecLayouts } from './SpecLayouts';

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: Array<[T, string, string]>; onChange: (v: T) => void }) {
  return (
    <div className="choices" role="radiogroup">
      {options.map(([v, label, hint]) => (
        <label key={v} className={`choice${v === value ? ' on' : ''}`}>
          <input type="radio" name={name} checked={v === value} onChange={() => onChange(v)} />
          <span><b>{label}</b><br /><span className="lede">{hint}</span></span>
        </label>))}
    </div>
  );
}

export function Settings() {
  const p = usePrefs();
  return (
    <>
      <h1>Settings</h1>
      <p className="lede">Display preferences, saved in this browser only. Each computer keeps its own; nothing here touches your inventory.</p>

      <h2>Row density</h2>
      <Choice<Prefs['density']> name="density" value={p.density} onChange={(density) => setPrefs({ density })} options={[
        ['compact', 'Compact', 'More rows on screen. Best for scanning a long list.'],
        ['comfortable', 'Comfortable', 'Taller rows with more space around the text.'],
      ]} />

      <h2>Part details</h2>
      <Choice<'side' | 'page'> name="panel" value={p.sidePanel ? 'side' : 'page'} onChange={(v) => setPrefs({ sidePanel: v === 'side' })} options={[
        ['side', 'Beside the table', 'On wide screens (1400 px and up) clicking a row opens the part next to the list, so you keep your place.'],
        ['page', 'Full page', 'Clicking a row always opens the part on its own page.'],
      ]} />

      <h2>Theme</h2>
      <Choice<Prefs['theme']> name="theme" value={p.theme} onChange={(theme) => setPrefs({ theme })} options={[
        ['system', 'Match my system', 'Follow the light or dark setting of this computer.'],
        ['light', 'Light', ''],
        ['dark', 'Dark', ''],
      ]} />

      <h2>Saved layouts</h2>
      <p className="lede">The Parts table remembers which columns you show, their order and widths. Use <b>Columns</b> above the table to change them.</p>
      <button className="secondary" onClick={() => { clearSaved('partlib.layout.'); location.reload(); }}>Reset the Parts table layout</button>

      <SpecLayouts />
    </>
  );
}
