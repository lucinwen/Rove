import type { TouchEvent } from '../../shared/protocol.ts';

type OutputResult = { mode: 'visual' | 'gamepad'; ok: boolean };
type AttemptResult = GamepadHapticsResult | 'cancelled' | 'timed-out';

/**
 * Visual feedback is the default. The optional output is a browser gamepad API,
 * not a wristband driver or proof that a physical actuator was felt.
 * The caller must check event age using its server clock estimate before play().
 */
export class HapticOutput {
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private readonly seen = new Set<string>();
  private active: GamepadHapticActuator | null = null;
  private cancelAttempt: (() => void) | null = null;
  private lastReset: Promise<void> = Promise.resolve();

  constructor(private readonly onPulse: () => void) {}

  setGamepadEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  async play(event: TouchEvent): Promise<OutputResult> {
    if (this.disposed || !event || typeof event.id !== 'string' || !event.id || event.id.length > 128 ||
        !Number.isFinite(event.durationMs) || !Number.isFinite(event.intensity) ||
        event.durationMs <= 0 || event.intensity <= 0 || this.seen.has(event.id)) {
      return { mode: 'visual', ok: false };
    }
    this.seen.add(event.id);
    if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value!);
    // Only one output may be live; stop also invalidates an older async completion.
    this.stop();
    const generation = this.generation;
    const duration = Math.min(100, Math.max(1, event.durationMs));
    const magnitude = Math.min(0.2, Math.max(0, event.intensity));
    if (!this.enabled) return this.visual(generation);

    const actuator = this.findActuator();
    if (!actuator) return this.visual(generation);
    await this.lastReset;
    if (!this.isCurrent(generation) || !this.enabled) return { mode: 'visual', ok: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<AttemptResult>(resolve => { cancel = () => resolve('cancelled'); });
    const timeout = new Promise<AttemptResult>(resolve => { timer = setTimeout(() => resolve('timed-out'), duration + 500); });
    this.active = actuator;
    this.cancelAttempt = cancel ?? null;
    try {
      const result = await Promise.race<AttemptResult>([
        actuator.playEffect('dual-rumble', {
          startDelay: 0, duration,
          strongMagnitude: magnitude, weakMagnitude: magnitude,
        }),
        cancelled, timeout,
      ]);
      if (!this.isCurrent(generation)) return { mode: 'gamepad', ok: false };
      this.active = null;
      this.cancelAttempt = null;
      if (result === 'complete') {
        // This confirms the browser API completed, not a measured hardware response.
        this.onPulse();
        return { mode: 'gamepad', ok: true };
      }
      this.resetActuator(actuator);
      return this.visual(generation);
    } catch {
      if (!this.isCurrent(generation)) return { mode: 'gamepad', ok: false };
      this.active = null;
      this.cancelAttempt = null;
      this.resetActuator(actuator);
      return this.visual(generation);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Stops device output and prevents any previous attempt from pulsing on completion. */
  stop(): void {
    this.generation++;
    this.cancelAttempt?.();
    this.cancelAttempt = null;
    const actuator = this.active;
    this.active = null;
    if (actuator) this.resetActuator(actuator);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.enabled = false;
    this.seen.clear();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private visual(generation: number): OutputResult {
    if (!this.isCurrent(generation)) return { mode: 'visual', ok: false };
    this.onPulse();
    return { mode: 'visual', ok: true };
  }

  private findActuator(): GamepadHapticActuator | null {
    // Device enumeration happens only after the user enables local gamepad output.
    if (!this.enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    try {
      for (const pad of navigator.getGamepads()) {
        const actuator = pad?.connected ? pad.vibrationActuator : undefined;
        if (actuator && typeof actuator.playEffect === 'function') return actuator;
      }
    } catch { /* Permissions and unsupported implementations fall back to visual output. */ }
    return null;
  }

  private resetActuator(actuator: GamepadHapticActuator): void {
    try {
      // Invoke immediately; never wait for the previous effect to finish before stopping it.
      const reset = typeof actuator.reset === 'function' ? actuator.reset() : Promise.resolve('preempted');
      // Bound a broken browser's reset promise so future visual feedback remains responsive.
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.lastReset = Promise.race([
        Promise.resolve(reset).then(() => undefined, () => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 200); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    } catch {
      this.lastReset = Promise.resolve();
    }
  }
}
