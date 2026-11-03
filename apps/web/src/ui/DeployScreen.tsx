import { useState } from 'react';
import { ATTACHMENTS, CLASSES, getWeapon, sanitizeLoadout, type AttachmentSlot, type Loadout } from '@frontline/game-config';
import type { TeamName } from '@frontline/shared';
import { useHud, type HudStore } from '../game/hud/HudStore';

const SLOT_LABELS: Record<AttachmentSlot, string> = { optic: '瞄具', muzzle: '槍口', magazine: '彈匣' };
const KEY = 'frontline.loadout.v1';

export function loadSavedLoadout(): Loadout {
  try {
    return sanitizeLoadout(JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Loadout>);
  } catch {
    return sanitizeLoadout(undefined);
  }
}

function saveLoadout(loadout: Loadout): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(loadout));
  } catch {
    // 忽略
  }
}

interface DeployScreenProps {
  store: HudStore;
  lockError: string | null;
  onDeploy(loadout: Loadout, spawn: string): void;
  onTeam(team: TeamName): void;
  onLeave(): void;
  onSettings(): void;
}

/** 部署畫面：選隊、兵種、主武器、配件與出生點（征服模式可選己方據點）。 */
export function DeployScreen({ store, lockError, onDeploy, onTeam, onLeave, onSettings }: DeployScreenProps) {
  const [loadout, setLoadout] = useState<Loadout>(loadSavedLoadout);
  const [spawn, setSpawn] = useState('base');
  const team = useHud(store, (s) => s.team);
  const respawnIn = useHud(store, (s) => s.respawnIn);
  const mode = useHud(store, (s) => s.mode);
  const phase = useHud(store, (s) => s.phase);
  const objectives = useHud(store, (s) => s.objectives);
  const scoreboard = useHud(store, (s) => s.scoreboard);
  const owned = objectives.filter((o) => o.owner === team);
  const cls = CLASSES.find((c) => c.id === loadout.classId) ?? CLASSES[0]!;
  const primary = getWeapon(loadout.primaryId);

  const update = (next: Partial<Loadout>) => {
    const merged = sanitizeLoadout({ ...loadout, ...next });
    setLoadout(merged);
    saveLoadout(merged);
  };
  const setAttachment = (slot: AttachmentSlot, id: string) => {
    const current = (loadout.attachments[loadout.primaryId] ?? []).filter((a) => ATTACHMENTS.find((x) => x.id === a)?.slot !== slot);
    update({ attachments: { ...loadout.attachments, [loadout.primaryId]: id ? [...current, id] : current } });
  };

  return (
    <div className="overlay">
      <div className="panel panel--wide lobby" data-testid="deploy-screen">
        <h1 className="title">部署</h1>
        <p className="subtitle">
          {mode === 'conquest' ? '征服' : '團隊死鬥'} · {phase === 'warmup' ? '暖身中' : phase === 'ended' ? '對戰結束' : '進行中'}
        </p>
        <div className="lobby__teams">
          {(['alpha', 'bravo'] as const).map((t) => (
            <div key={t} className={`lobby__team team-${t}`}>
              <strong>{t === 'alpha' ? 'ALPHA' : 'BRAVO'}</strong> {team === t ? '（你的隊伍）' : ''}
              <ul>
                {scoreboard
                  .filter((p) => p.team === t)
                  .map((p) => (
                    <li key={p.id}>
                      {p.name}
                      {p.bot ? '（Bot）' : ''}
                    </li>
                  ))}
              </ul>
              {team !== t && (
                <button type="button" className="button button--small" onClick={() => onTeam(t)}>
                  加入 {t === 'alpha' ? 'ALPHA' : 'BRAVO'}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="class-grid" role="radiogroup" aria-label="兵種">
          {CLASSES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === cls.id}
              className={`button class-card ${c.id === cls.id ? 'is-selected' : ''}`}
              onClick={() => update({ classId: c.id, primaryId: c.primaryOptions[0]!, secondaryId: c.secondaryOptions[0]! })}
            >
              {c.displayName}
              <small>{c.description}</small>
            </button>
          ))}
        </div>
        <label className="setting setting--row">
          <span>主武器</span>
          <select aria-label="主武器" value={loadout.primaryId} onChange={(e) => update({ primaryId: e.target.value })}>
            {cls.primaryOptions.map((id) => (
              <option key={id} value={id}>
                {getWeapon(id).displayName}
              </option>
            ))}
          </select>
        </label>
        {primary.attachmentSlots.map((slot) => (
          <label key={slot} className="setting setting--row">
            <span>{SLOT_LABELS[slot]}</span>
            <select
              aria-label={`配件：${SLOT_LABELS[slot]}`}
              value={(loadout.attachments[loadout.primaryId] ?? []).find((a) => ATTACHMENTS.find((x) => x.id === a)?.slot === slot) ?? ''}
              onChange={(e) => setAttachment(slot, e.target.value)}
            >
              <option value="">無</option>
              {ATTACHMENTS.filter((a) => a.slot === slot && a.compatible.includes(primary.category)).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>
        ))}
        {mode === 'conquest' && (
          <label className="setting setting--row">
            <span>出生點</span>
            <select aria-label="出生點" value={spawn} onChange={(e) => setSpawn(e.target.value)}>
              <option value="base">基地</option>
              {owned.map((o) => (
                <option key={o.id} value={o.id}>
                  據點 {o.id} · {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="button button--primary" onClick={() => onDeploy(loadout, spawn)}>
          {respawnIn > 0 ? `部署（${Math.ceil(respawnIn)} 秒後出生）` : '部署'}
        </button>
        {lockError && (
          <p className="error" role="alert">
            {lockError}
          </p>
        )}
        <div className="setting--row">
          <button type="button" className="button" onClick={onSettings}>
            設定
          </button>
          <button type="button" className="button" onClick={onLeave}>
            離開對戰
          </button>
        </div>
      </div>
    </div>
  );
}
