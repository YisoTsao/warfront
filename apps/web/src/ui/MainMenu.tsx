import { useState } from 'react';
import { CLASSES, getWeapon, type Loadout } from '@frontline/game-config';
import { sanitizeName, type GuestProfile } from '../app/profile';
import { AVAILABLE_MAPS } from '../game/world/maps';

export type MenuChoice =
  | { kind: 'quickMatch'; mode: 'tdm' | 'conquest'; mapId: string; bots: number }
  | { kind: 'serverList' }
  | { kind: 'training'; mapId: string; loadout: Partial<Loadout> }
  | { kind: 'settings' };

interface MainMenuProps {
  profile: GuestProfile;
  onProfileChange(profile: GuestProfile): void;
  onChoose(choice: MenuChoice): void;
}

export function MainMenu({ profile, onProfileChange, onChoose }: MainMenuProps) {
  const [name, setName] = useState(profile.name);
  const [mapId, setMapId] = useState<string>(AVAILABLE_MAPS[0].id);
  const [matchMap, setMatchMap] = useState<string>(AVAILABLE_MAPS[0].id);
  const [bots, setBots] = useState(8);
  const [classId, setClassId] = useState('assault');
  const [primaryId, setPrimaryId] = useState('ar_carbine');
  const cls = CLASSES.find((c) => c.id === classId) ?? CLASSES[0]!;

  const commitName = () => {
    const next = { ...profile, name: sanitizeName(name) };
    setName(next.name);
    onProfileChange(next);
  };

  return (
    <div className="overlay overlay--solid menu">
      <div className="panel panel--wide">
        <h1 className="title">FRONTLINE</h1>
        <p className="subtitle">瀏覽器寫實多人射擊 · 8 對 8</p>
        <label className="setting">
          <span>玩家名稱（訪客）</span>
          <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} onBlur={commitName} aria-label="玩家名稱" />
        </label>
        <div className="menu__grid">
          <section>
            <h2>線上對戰</h2>
            <label className="setting setting--row">
              <span>地圖</span>
              <select value={matchMap} onChange={(e) => setMatchMap(e.target.value)} aria-label="對戰地圖">
                {AVAILABLE_MAPS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting setting--row">
              <span>人數不足時以 bot 補到</span>
              <select value={bots} onChange={(e) => setBots(Number(e.target.value))} aria-label="bot 補位人數">
                {[0, 4, 8, 12, 16].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '不使用 bot' : `${n} 人`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                commitName();
                onChoose({ kind: 'quickMatch', mode: 'tdm', mapId: matchMap, bots });
              }}
            >
              快速對戰：團隊死鬥
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                commitName();
                onChoose({ kind: 'quickMatch', mode: 'conquest', mapId: matchMap, bots });
              }}
            >
              快速對戰：征服
            </button>
            <button type="button" className="button" onClick={() => { commitName(); onChoose({ kind: 'serverList' }); }}>
              伺服器列表
            </button>
          </section>
          <section>
            <h2>訓練場</h2>
            <label className="setting setting--row">
              <span>地圖</span>
              <select value={mapId} onChange={(e) => setMapId(e.target.value)} aria-label="訓練場地圖">
                {AVAILABLE_MAPS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting setting--row">
              <span>兵種</span>
              <select
                value={classId}
                onChange={(e) => {
                  setClassId(e.target.value);
                  setPrimaryId(CLASSES.find((c) => c.id === e.target.value)?.primaryOptions[0] ?? 'ar_carbine');
                }}
                aria-label="訓練場兵種"
              >
                {CLASSES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting setting--row">
              <span>主武器</span>
              <select value={primaryId} onChange={(e) => setPrimaryId(e.target.value)} aria-label="訓練場主武器">
                {cls.primaryOptions.map((id) => (
                  <option key={id} value={id}>
                    {getWeapon(id).displayName}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={() => onChoose({ kind: 'training', mapId, loadout: { classId, primaryId } })}>
              進入訓練場
            </button>
          </section>
        </div>
        <button type="button" className="button" onClick={() => onChoose({ kind: 'settings' })}>
          設定
        </button>
      </div>
    </div>
  );
}
