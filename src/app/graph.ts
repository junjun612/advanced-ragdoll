// 실시간 그래프 (SPEC 14 '그래프'의 v0.2 부분집합): COM 높이, 관절 오차 평균, 루트 보조 사용량.
// sim 시간 기준으로 표본을 모은다(일시정지하면 멈춘다). 2D 캔버스에 줄마다 값 + 선 그래프를 그린다.

export interface Series {
  label: string;
  unit: string;
  color: string;
  max: number;
  digits: number;
}

export class LiveGraph {
  private readonly data: { t: number; v: number[] }[] = [];
  private lastT = -Infinity;
  /** 오른쪽 덧붙임 글 (예: 보조 적분) */
  extra: string[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly series: Series[],
    readonly windowSec: number,
    readonly sampleHz: number,
    readonly font: string,
  ) {}

  clear(): void {
    this.data.length = 0;
    this.lastT = -Infinity;
  }

  push(t: number, values: number[]): void {
    if (t < this.lastT) this.clear();
    if (t - this.lastT < 1 / this.sampleHz - 1e-9) return;
    this.lastT = t;
    this.data.push({ t, v: values });
    while (this.data.length && this.data[0]!.t < t - this.windowSec) this.data.shift();
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const n = this.series.length;
    const rowH = H / n;
    const labelW = 150;
    const last = this.data[this.data.length - 1];
    const tEnd = last?.t ?? 0;
    g.textBaseline = 'middle';
    this.series.forEach((s, i) => {
      const y0 = i * rowH;
      g.fillStyle = '#333';
      g.font = `12px ${this.font}`;
      g.fillText(s.label, 8, y0 + rowH * 0.32);
      const v = last?.v[i];
      g.font = `bold 14px ${this.font}`;
      g.fillStyle = s.color;
      const vt = v === undefined ? '—' : `${v.toFixed(s.digits)} ${s.unit}`;
      g.fillText(vt, 8, y0 + rowH * 0.7);
      if (this.extra[i]) {
        const w = g.measureText(vt).width;
        g.font = `11px ${this.font}`;
        g.fillStyle = '#666';
        g.fillText(this.extra[i]!, 8 + w + 6, y0 + rowH * 0.7);
      }
      // 그래프 영역
      const x0 = labelW, x1 = W - 8, gy0 = y0 + 6, gy1 = y0 + rowH - 6;
      g.strokeStyle = '#ddd';
      g.lineWidth = 1;
      g.strokeRect(x0 + 0.5, gy0 + 0.5, x1 - x0, gy1 - gy0);
      g.fillStyle = '#999';
      g.font = `10px ${this.font}`;
      g.textAlign = 'right';
      g.fillText(`${s.max}`, x1 - 3, gy0 + 7);
      g.textAlign = 'left';
      g.strokeStyle = s.color;
      g.lineWidth = 1.6;
      g.beginPath();
      let first = true;
      for (const d of this.data) {
        const x = x1 - ((tEnd - d.t) / this.windowSec) * (x1 - x0);
        const r = Math.min(1, Math.max(0, d.v[i]! / s.max));
        const y = gy1 - r * (gy1 - gy0);
        if (first) g.moveTo(x, y); else g.lineTo(x, y);
        first = false;
      }
      g.stroke();
    });
  }
}
