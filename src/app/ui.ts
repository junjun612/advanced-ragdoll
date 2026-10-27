// 패널 DOM 도우미: 섹션, 슬라이더, 버튼 줄, 체크박스. 보이는 글은 모두 호출자가 한글로 준다.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export function section(parent: HTMLElement, title: string, open = true): HTMLElement {
  const d = el('details', { class: 'section' });
  d.open = open;
  d.append(el('summary', {}, title));
  const body = el('div', { class: 'section-body' });
  d.append(body);
  parent.append(d);
  return body;
}

export interface Slider {
  row: HTMLElement;
  input: HTMLInputElement;
  /** 값과 표시를 바꾼다 (이벤트는 부르지 않는다) */
  set(v: number): void;
  /** 표시 글만 다시 만든다 */
  refresh(): void;
}

/** 라벨 · 슬라이더 · 값 표시 한 줄. fmt는 표시 글, toPos/fromPos로 로그 눈금 등을 쓸 수 있다 */
export function slider(
  parent: HTMLElement,
  label: string,
  opts: {
    min: number; max: number; step?: number; value: number;
    fmt: (v: number) => string;
    onInput: (v: number) => void;
    log?: boolean;
    title?: string;
  },
): Slider {
  const { min, max, log } = opts;
  const toPos = (v: number) => (log ? Math.log(Math.max(v, min) / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));
  const input = el('input', { type: 'range', min: '0', max: '1', step: 'any' });
  const out = el('span', { class: 'val' });
  const row = el('label', { class: 'slider' }, el('span', { class: 'lbl' }, label), input, out);
  if (opts.title) row.title = opts.title;
  let value = opts.value;
  const snap = (v: number) => (opts.step ? Math.round(v / opts.step) * opts.step : v);
  const s: Slider = {
    row, input,
    set(v) { value = v; input.value = String(toPos(v)); out.textContent = opts.fmt(v); },
    refresh() { out.textContent = opts.fmt(value); },
  };
  input.addEventListener('input', () => {
    value = snap(fromPos(Number(input.value)));
    out.textContent = opts.fmt(value);
    opts.onInput(value);
  });
  s.set(opts.value);
  parent.append(row);
  return s;
}

export function buttons(parent: HTMLElement, items: { label: string; onClick: () => void; id?: string; title?: string }[], cls = 'btn-row'): HTMLButtonElement[] {
  const row = el('div', { class: cls });
  const out = items.map((it) => {
    const b = el('button', it.id ? { id: it.id } : {}, it.label);
    if (it.title) b.title = it.title;
    b.addEventListener('click', it.onClick);
    row.append(b);
    return b;
  });
  parent.append(row);
  return out;
}

/** 하나만 고르는 버튼 묶음 */
export function segmented<T extends string | number>(parent: HTMLElement, items: { label: string; value: T }[], value: T, onChange: (v: T) => void): { set(v: T): void } {
  const row = el('div', { class: 'seg' });
  const bs = items.map((it) => {
    const b = el('button', {}, it.label);
    b.addEventListener('click', () => { set(it.value); onChange(it.value); });
    row.append(b);
    return { b, v: it.value };
  });
  const set = (v: T) => bs.forEach((x) => x.b.classList.toggle('on', x.v === v));
  set(value);
  parent.append(row);
  return { set };
}

export function checkbox(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void, swatch?: string): HTMLInputElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const row = el('label', { class: 'check' }, input);
  if (swatch) row.append(el('span', { class: 'swatch', style: `background:${swatch}` }));
  row.append(label);
  parent.append(row);
  return input;
}
