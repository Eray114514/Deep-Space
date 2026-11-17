// Shared behaviour for MENU-language lists (hero, pause): one white inverse
// selection bar that slides between rows, arrow-key navigation, and UI foley.
// Rows are `.menu-item` buttons inside a `.menu-list` container. The bar is a
// single absolutely-positioned element so moving it is a transform, not a
// repaint of every row.

const playSound = (name) => window.dispatchEvent(new CustomEvent('ui-sound', { detail: name }));

export function bindMenuList(list) {
  if (!list || list._menuNav) return list?._menuNav;
  const cursor = document.createElement('i');
  cursor.className = 'menu-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  list.prepend(cursor);
  let current = null;

  const items = () => [...list.querySelectorAll('.menu-item')].filter((item) => !item.disabled);
  const visible = () => list.offsetParent !== null;

  const place = () => {
    if (!current || !visible()) { cursor.style.opacity = '0'; return; }
    const listBox = list.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    cursor.style.opacity = '1';
    cursor.style.height = `${box.height}px`;
    cursor.style.width = `${box.width}px`;
    cursor.style.transform = `translate(${box.left - listBox.left}px, ${box.top - listBox.top}px)`;
  };

  const select = (item, { sound = true, focus = false } = {}) => {
    if (!item || item.disabled) return;
    if (item !== current) {
      current?.classList.remove('is-current');
      item.classList.add('is-current');
      current = item;
      if (sound) playSound('ui_hover');
    }
    if (focus && document.activeElement !== item) item.focus({ preventScroll: true });
    place();
  };

  list.addEventListener('pointerover', (event) => {
    const item = event.target.closest?.('.menu-item');
    if (item && list.contains(item)) select(item);
  });
  list.addEventListener('focusin', (event) => {
    const item = event.target.closest?.('.menu-item');
    if (item) select(item);
  });
  list.addEventListener('click', (event) => {
    const item = event.target.closest?.('.menu-item');
    if (item && !item.disabled) playSound('ui_click');
  });

  const onKey = (event) => {
    if (!visible() || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    if (event.target instanceof HTMLInputElement) return;
    // A modal opened on top of this list (graphics settings, GPU tutorial)
    // owns the arrow keys; never pull focus back behind it.
    const openDialog = [...document.querySelectorAll('[aria-modal="true"]')]
      .find((dialog) => !dialog.classList.contains('hidden') && dialog.offsetParent !== null && !dialog.contains(list));
    if (openDialog) return;
    const rows = items();
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    const index = rows.indexOf(current);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    select(rows[(index + step + rows.length) % rows.length], { focus: true });
  };
  document.addEventListener('keydown', onKey, true);

  // Layout changes (show/hide, font load, resize) re-seat the bar.
  new ResizeObserver(() => {
    if (!current || !current.isConnected || current.disabled) current = null;
    if (!current) {
      const first = items()[0];
      if (first) { first.classList.add('is-current'); current = first; }
    }
    // Snap without animating when the list first becomes visible.
    cursor.classList.add('is-snapping');
    place();
    requestAnimationFrame(() => cursor.classList.remove('is-snapping'));
  }).observe(list);
  document.fonts?.ready.then(place);

  const api = {
    // focus: true also moves keyboard focus so Enter confirms the lit row.
    reset({ focus = false } = {}) {
      current?.classList.remove('is-current');
      current = null;
      const first = items()[0];
      if (first) select(first, { sound: false, focus });
    },
    select: (item) => select(item, { sound: false }),
  };
  list._menuNav = api;
  return api;
}
