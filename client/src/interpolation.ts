export interface CursorSample {
  x: number;
  y: number;
  receivedAt: number;
}

export interface InterpolatedPosition {
  x: number;
  y: number;
}

// Entity interpolation buffer to render remote cursor updates smoothly
export class CursorInterpolator {
  private samples: CursorSample[] = [];
  private readonly interpolationDelay: number;
  private readonly maxSamples = 10;

  constructor(interpolationDelay = 100) {
    this.interpolationDelay = interpolationDelay;
  }

  addSample(x: number, y: number, receivedAt = performance.now()): void {
    this.samples.push({ x, y, receivedAt });

    // Ring-buffer style drop of oldest samples to avoid memory leaks
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getPosition(currentTime = performance.now()): InterpolatedPosition | null {
    if (this.samples.length === 0) return null;

    if (this.samples.length === 1) {
      return {
        x: this.samples[0].x,
        y: this.samples[0].y,
      };
    }

    // Render slightly behind real-time so we have two surrounding samples to lerp between
    const renderTime = currentTime - this.interpolationDelay;

    let previous = this.samples[0];
    let next = this.samples[1];

    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].receivedAt >= renderTime) {
        previous = this.samples[i - 1];
        next = this.samples[i];
        break;
      }

      previous = this.samples[i];
      next = i + 1 < this.samples.length ? this.samples[i + 1] : this.samples[i];
    }

    // If render time exceeds our newest sample, extrapolate by clamping to the latest known point
    const latest = this.samples[this.samples.length - 1];
    if (renderTime >= latest.receivedAt) {
      return {
        x: latest.x,
        y: latest.y,
      };
    }

    const duration = next.receivedAt - previous.receivedAt;
    if (duration <= 0) {
      return {
        x: previous.x,
        y: previous.y,
      };
    }

    // Linear interpolation (lerp) clamped between 0 and 1
    const progress = (renderTime - previous.receivedAt) / duration;
    const t = Math.max(0, Math.min(1, progress));

    return {
      x: previous.x + (next.x - previous.x) * t,
      y: previous.y + (next.y - previous.y) * t,
    };
  }

  clear(): void {
    this.samples = [];
  }

  getSampleCount(): number {
    return this.samples.length;
  }
}