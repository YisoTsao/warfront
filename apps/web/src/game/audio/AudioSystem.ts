import type * as THREE from 'three';

const SPEED_OF_SOUND = 343;
const MAX_VOICES = 40;

export interface VolumeSettings {
  master: number;
  effects: number;
  music: number;
}

export interface GunSound {
  pitch: number;
  length: number;
  suppressed: boolean;
}

type Position = { x: number; y: number; z: number };

/**
 * 以 WebAudio 合成的音效（尚未有錄音素材）。所有世界中的聲音都經過 HRTF 空間化；
 * 遠處槍聲會被低通濾波並依音速延遲。AudioContext 只在玩家點擊後才啟動。
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private effects: GainNode | null = null;
  private music: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private ambience: { stop(): void } | null = null;
  private volumes: VolumeSettings = { master: 0.8, effects: 1, music: 0.5 };
  private listenerPosition: Position = { x: 0, y: 0, z: 0 };
  private birdTimer = 4;

  /** 必須在使用者手勢（點擊）中呼叫。 */
  resume(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.effects = this.ctx.createGain();
      this.effects.connect(this.master);
      this.music = this.ctx.createGain();
      this.music.connect(this.master);
      const length = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.applyVolumes();
      this.startAmbience();
    }
    void this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  setVolumes(volumes: VolumeSettings): void {
    this.volumes = volumes;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.effects || !this.music) {
      return;
    }
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.effects.gain.setTargetAtTime(this.volumes.effects, t, 0.05);
    this.music.gain.setTargetAtTime(this.volumes.music, t, 0.05);
  }

  /** 每畫格更新聆聽者（相機）的位置與朝向。 */
  updateListener(camera: THREE.Camera, frameSeconds: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const l = ctx.listener;
    const p = camera.position;
    this.listenerPosition = { x: p.x, y: p.y, z: p.z };
    const e = camera.matrixWorld.elements;
    const forward = { x: -e[8]!, y: -e[9]!, z: -e[10]! };
    const up = { x: e[4]!, y: e[5]!, z: e[6]! };
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.y, t);
      l.forwardZ.setValueAtTime(forward.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    }
    this.birdTimer -= frameSeconds;
    if (this.birdTimer <= 0) {
      this.birdTimer = 5 + Math.random() * 10;
      this.bird();
    }
  }

  // ---- 聲音 ----

  gunshot(position: Position | null, sound: GunSound): void {
    const distance = position ? this.distanceTo(position) : 0;
    const delay = distance / SPEED_OF_SOUND;
    const far = distance > 60;
    const pitch = sound.pitch;
    const length = sound.length * (far ? 1.6 : 1);
    const loud = sound.suppressed ? 0.25 : 1;
    this.voice(position, delay, (ctx, out, t) => {
      // 爆裂聲：濾波後的噪音
      const crack = this.noiseSource(ctx, t, length);
      const band = ctx.createBiquadFilter();
      band.type = far ? 'lowpass' : 'bandpass';
      band.frequency.value = far ? 900 : (sound.suppressed ? 2600 : 1800) * pitch;
      band.Q.value = far ? 0.5 : 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.9 * loud, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
      crack.connect(band).connect(gain).connect(out);
      // 低頻衝擊
      if (!sound.suppressed) {
        const thump = ctx.createOscillator();
        thump.type = 'sine';
        thump.frequency.setValueAtTime(140 * pitch, t);
        thump.frequency.exponentialRampToValueAtTime(40, t + 0.12);
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(far ? 0.3 : 0.8, t);
        tg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        thump.connect(tg).connect(out);
        thump.start(t);
        thump.stop(t + 0.16);
      }
      return length + 0.1;
    });
  }

  dryFire(): void {
    this.click(null, 3200, 0.03, 0.25);
  }

  reloadStep(stage: 'out' | 'in' | 'charge'): void {
    const freq = stage === 'out' ? 1400 : stage === 'in' ? 2200 : 900;
    this.click(null, freq, 0.05, 0.35);
  }

  footstep(position: Position | null, surface: string, loudness = 1): void {
    const freq = surface === 'wood' ? 700 : surface === 'metal' ? 2400 : surface === 'stone' || surface === 'concrete' || surface === 'rock' ? 1300 : surface === 'water' ? 500 : 420;
    const length = surface === 'water' ? 0.18 : 0.07;
    this.voice(position, 0, (ctx, out, t) => {
      const src = this.noiseSource(ctx, t, length);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq * (0.9 + Math.random() * 0.2);
      filter.Q.value = surface === 'metal' ? 4 : 1;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.35 * loudness, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
      src.connect(filter).connect(gain).connect(out);
      return length + 0.05;
    });
  }

  impact(position: Position, material: string): void {
    const freq = material === 'metal' ? 3000 : material === 'wood' ? 900 : material === 'flesh' ? 300 : 1500;
    this.voice(position, 0, (ctx, out, t) => {
      const src = this.noiseSource(ctx, t, 0.08);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = material === 'metal' ? 6 : 1.2;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      src.connect(filter).connect(gain).connect(out);
      return 0.12;
    });
  }

  /** 子彈從身邊飛過 */
  bulletWhiz(position: Position): void {
    this.voice(position, 0, (ctx, out, t) => {
      const src = this.noiseSource(ctx, t, 0.15);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(4000, t);
      filter.frequency.exponentialRampToValueAtTime(1200, t + 0.15);
      filter.Q.value = 3;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      src.connect(filter).connect(gain).connect(out);
      return 0.2;
    });
  }

  hitMarker(kind: 'hit' | 'headshot' | 'kill'): void {
    const freq = kind === 'kill' ? 1400 : kind === 'headshot' ? 2600 : 1900;
    this.voice(null, 0, (ctx, out, t) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'kill' ? 0.25 : 0.06));
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + 0.3);
      return 0.3;
    });
  }

  explosion(position: Position): void {
    const distance = this.distanceTo(position);
    this.voice(position, distance / SPEED_OF_SOUND, (ctx, out, t) => {
      const src = this.noiseSource(ctx, t, 1.6);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2500, t);
      filter.frequency.exponentialRampToValueAtTime(120, t + 1.4);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
      src.connect(filter).connect(gain).connect(out);
      const boom = ctx.createOscillator();
      boom.frequency.setValueAtTime(70, t);
      boom.frequency.exponentialRampToValueAtTime(25, t + 0.6);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(1.2, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      boom.connect(bg).connect(out);
      boom.start(t);
      boom.stop(t + 0.7);
      return 1.7;
    });
  }

  dispose(): void {
    this.ambience?.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  // ---- 內部 ----

  private distanceTo(p: Position): number {
    return Math.hypot(p.x - this.listenerPosition.x, p.y - this.listenerPosition.y, p.z - this.listenerPosition.z);
  }

  private click(position: Position | null, freq: number, length: number, volume: number): void {
    this.voice(position, 0, (ctx, out, t) => {
      const src = this.noiseSource(ctx, t, length);
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
      src.connect(filter).connect(gain).connect(out);
      return length + 0.05;
    });
  }

  private noiseSource(ctx: AudioContext, t: number, length: number): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.5, length + 0.05);
    return src;
  }

  /** 建立一個聲音：position 為 null 時不做空間化（自己的槍聲、介面音）。 */
  private voice(position: Position | null, delay: number, build: (ctx: AudioContext, out: AudioNode, t: number) => number): void {
    const ctx = this.ctx;
    if (!ctx || !this.effects || ctx.state !== 'running' || this.voices >= MAX_VOICES) {
      return;
    }
    if (position && this.distanceTo(position) > 400) {
      return;
    }
    const t = ctx.currentTime + delay;
    let out: AudioNode = this.effects;
    let panner: PannerNode | null = null;
    if (position) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.maxDistance = 400;
      panner.rolloffFactor = 1.2;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
      panner.connect(this.effects);
      out = panner;
    }
    const duration = build(ctx, out, t);
    this.voices++;
    window.setTimeout(
      () => {
        this.voices--;
        panner?.disconnect();
      },
      (delay + duration) * 1000 + 50,
    );
  }

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.music || !this.noise) {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    const gain = ctx.createGain();
    gain.gain.value = 0.06;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.music);
    src.start();
    lfo.start();
    this.ambience = {
      stop: () => {
        src.stop();
        lfo.stop();
      },
    };
  }

  private bird(): void {
    const ctx = this.ctx;
    if (!ctx || !this.music || ctx.state !== 'running') {
      return;
    }
    const t = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const start = t + i * 0.13;
      const base = 2800 + Math.random() * 1500;
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.exponentialRampToValueAtTime(base * 1.4, start + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.03, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      osc.connect(g).connect(this.music);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }
}
