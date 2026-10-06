import { ImportCart } from './ImportCart';
import { ImportLcsc } from './ImportLcsc';
import { setParams, useRoute } from './route';

/** One Import page for both LCSC files: what arrived (order export) and what you plan to buy (cart export). */
export function ImportPage() {
  const kind = useRoute().params.get('kind') === 'cart' ? 'cart' : 'order';
  return (
    <>
      <h1>Import from LCSC</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={kind === 'order'} className={kind === 'order' ? 'tab on' : 'tab'} onClick={() => setParams({ kind: null })}>Order export (parts that arrived)</button>
        <button role="tab" aria-selected={kind === 'cart'} className={kind === 'cart' ? 'tab on' : 'tab'} onClick={() => setParams({ kind: 'cart' })}>Cart export (parts to buy)</button>
      </div>
      {kind === 'cart' ? <ImportCart /> : <ImportLcsc />}
    </>
  );
}
