import { useEffect, useState } from 'react';
import { useHud, type HudStore } from '../game/hud/HudStore';

const TEAM_NAMES = { alpha: 'ALPHA', bravo: 'BRAVO' } as const;

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function HitMarker({ store }: { store: HudStore }) {
  const marker = useHud(store, (s) => s.hitMarker);
  if (marker.serial === 0) {
    return null;
  }
  const kind = marker.kill ? 'kill' : marker.headshot ? 'headshot' : 'hit';
  return <div key={marker.serial} className={`hitmarker hitmarker--${kind}`} data-testid="hitmarker" data-kind={kind} aria-hidden="true" />;
}

function DamageIndicator({ store }: { store: HudStore }) {
  const damage = useHud(store, (s) => s.damageFrom);
  if (damage.serial === 0) {
    return null;
  }
  return <div key={damage.serial} className="damage-indicator" style={{ transform: `translate(-50%, -50%) rotate(${damage.angle}rad)` }} aria-hidden="true" />;
}

function KillFeed({ store, now }: { store: HudStore; now: number }) {
  const feed = useHud(store, (s) => s.killFeed);
  return (
    <ul className="killfeed" aria-label="擊殺訊息">
      {feed
        .filter((k) => now - k.at < 6000)
        .slice(-5)
        .map((k) => (
        <li key={k.id}>
          <span className={`team-${k.killerTeam ?? 'none'}`}>{k.killer}</span>
          <span className="killfeed__weapon">
            {k.weapon}
            {k.headshot ? ' ✛' : ''}
          </span>
          <span className={`team-${k.victimTeam ?? 'none'}`}>{k.victim}</span>
        </li>
        ))}
    </ul>
  );
}

function WeaponPanel({ store }: { store: HudStore }) {
  const weaponName = useHud(store, (s) => s.weaponName);
  const fireMode = useHud(store, (s) => s.fireMode);
  const ammo = useHud(store, (s) => s.ammo);
  const reserve = useHud(store, (s) => s.reserve);
  const reloading = useHud(store, (s) => s.reloading);
  const grenades = useHud(store, (s) => s.grenades);
  const abilityName = useHud(store, (s) => s.abilityName);
  const abilityReadyIn = useHud(store, (s) => s.abilityReadyIn);
  return (
    <div className="hud-weapon" aria-label="武器">
      <div className="hud-weapon__ammo">
        <span data-testid="ammo">{ammo}</span>
        <span className="hud-weapon__reserve">/ {reserve}</span>
      </div>
      <div className="hud-weapon__name">
        {weaponName} · {fireMode}
      </div>
      {reloading && <div className="hud-weapon__reloading">換彈中…</div>}
      {(grenades > 0 || abilityName) && (
        <div className="hud-weapon__gear">
          {grenades > 0 && <span>手榴彈 ×{grenades}</span>}
          {abilityName && <span>{abilityReadyIn > 0 ? `${abilityName} ${Math.ceil(abilityReadyIn)}s` : `${abilityName} 就緒`}</span>}
        </div>
      )}
    </div>
  );
}

function HealthPanel({ store }: { store: HudStore }) {
  const health = useHud(store, (s) => s.health);
  const maxHealth = useHud(store, (s) => s.maxHealth);
  const fraction = Math.max(0, Math.min(1, health / Math.max(1, maxHealth)));
  return (
    <div className="hud-health" aria-label="血量">
      <div className="hud-health__bar">
        <div className="hud-health__fill" style={{ width: `${fraction * 100}%` }} data-low={fraction < 0.3} />
      </div>
      <span data-testid="health">{Math.ceil(health)}</span>
    </div>
  );
}

function MatchBar({ store }: { store: HudStore }) {
  const mode = useHud(store, (s) => s.mode);
  const phase = useHud(store, (s) => s.phase);
  const timeLeft = useHud(store, (s) => s.timeLeft);
  const scores = useHud(store, (s) => s.teamScores);
  const limit = useHud(store, (s) => s.scoreLimit);
  const team = useHud(store, (s) => s.team);
  const objectives = useHud(store, (s) => s.objectives);
  if (mode === 'offline') {
    return null;
  }
  return (
    <div className="match-bar" data-testid="match-bar">
      <div className={`match-bar__team team-alpha ${team === 'alpha' ? 'is-own' : ''}`}>
        ALPHA <strong data-testid="score-alpha">{Math.ceil(scores.alpha)}</strong>
      </div>
      <div className="match-bar__center">
        <div className="match-bar__time">{phase === 'warmup' ? `即將開始 ${formatTime(timeLeft)}` : formatTime(timeLeft)}</div>
        <div className="match-bar__mode">{mode === 'tdm' ? `團隊死鬥 · 目標 ${limit}` : '征服'}</div>
        {objectives.length > 0 && (
          <div className="match-bar__objectives">
            {objectives.map((o) => (
              <span
                key={o.id}
                className={`objective objective--${o.owner ?? 'none'} ${o.contested ? 'is-contested' : ''} ${o.inside ? 'is-inside' : ''}`}
                title={o.name}
                data-testid={`objective-${o.id}`}
                data-owner={o.owner ?? 'none'}
              >
                {o.id}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={`match-bar__team team-bravo ${team === 'bravo' ? 'is-own' : ''}`}>
        <strong data-testid="score-bravo">{Math.ceil(scores.bravo)}</strong> BRAVO
      </div>
    </div>
  );
}

function CaptureProgress({ store }: { store: HudStore }) {
  const objective = useHud(store, (s) => s.objectives.find((o) => o.inside) ?? null);
  const team = useHud(store, (s) => s.team);
  if (!objective) {
    return null;
  }
  const own = team === 'alpha' ? objective.progress : -objective.progress;
  return (
    <div className="capture" aria-label="佔領進度">
      <div>
        據點 {objective.id} · {objective.name} {objective.contested ? '（爭奪中）' : ''}
      </div>
      <div className="capture__bar">
        <div className="capture__fill" style={{ width: `${Math.abs(own) * 100}%` }} data-own={own >= 0} />
      </div>
    </div>
  );
}

function StatusOverlay({ store }: { store: HudStore }) {
  const lifeState = useHud(store, (s) => s.lifeState);
  const respawnIn = useHud(store, (s) => s.respawnIn);
  const bleedoutIn = useHud(store, (s) => s.bleedoutIn);
  const revive = useHud(store, (s) => s.reviveProgress);
  const restricted = useHud(store, (s) => s.restrictedWarning);
  const message = useHud(store, (s) => s.message);
  const connection = useHud(store, (s) => s.connection);
  return (
    <>
      {lifeState === 'dead' && (
        <div className="status status--dead" data-testid="dead-overlay">
          陣亡 · {respawnIn > 0 ? `${Math.ceil(respawnIn)} 秒後重新部署` : '即將重新部署'}
        </div>
      )}
      {lifeState === 'downed' && (
        <div className="status status--downed">
          倒地 · {Math.ceil(bleedoutIn)} 秒內等待醫療兵救援（按住 X 放棄）
        </div>
      )}
      {revive > 0 && <div className="status status--revive">救援中 {Math.round(revive * 100)}%</div>}
      {restricted > 0 && (
        <div className="status status--warning" role="alert">
          離開禁區！{Math.ceil(restricted)} 秒
        </div>
      )}
      {message && <div className="status status--message">{message}</div>}
      {(connection === 'reconnecting' || connection === 'disconnected') && (
        <div className="status status--warning" role="alert">
          {connection === 'reconnecting' ? '連線中斷，正在重新連線…' : '已與伺服器斷線'}
        </div>
      )}
    </>
  );
}

function Scoreboard({ store }: { store: HudStore }) {
  const show = useHud(store, (s) => s.showScoreboard);
  const rows = useHud(store, (s) => s.scoreboard);
  const ping = useHud(store, (s) => s.ping);
  if (!show || rows.length === 0) {
    return null;
  }
  return (
    <div className="scoreboard" data-testid="scoreboard">
      {(['alpha', 'bravo'] as const).map((team) => (
        <table key={team} className={`scoreboard__team team-${team}`}>
          <caption>{TEAM_NAMES[team]}</caption>
          <thead>
            <tr>
              <th>玩家</th>
              <th>兵種</th>
              <th>擊殺</th>
              <th>死亡</th>
              <th>助攻</th>
              <th>分數</th>
              <th>延遲</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => r.team === team)
              .sort((a, b) => b.score - a.score)
              .map((r) => (
                <tr key={r.id} className={`${r.isSelf ? 'is-self' : ''} ${r.alive ? '' : 'is-dead'}`}>
                  <td>
                    {r.name}
                    {r.bot ? '（Bot）' : ''}
                    {r.connected ? '' : '（斷線）'}
                  </td>
                  <td>{r.classId}</td>
                  <td>{r.kills}</td>
                  <td>{r.deaths}</td>
                  <td>{r.assists}</td>
                  <td>{r.score}</td>
                  <td>{r.bot ? '-' : r.ping}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
      <div className="scoreboard__ping">你的延遲 {ping} ms</div>
    </div>
  );
}

function MatchResult({ store, onLeave }: { store: HudStore; onLeave?: () => void }) {
  const phase = useHud(store, (s) => s.phase);
  const winner = useHud(store, (s) => s.winner);
  const team = useHud(store, (s) => s.team);
  const scores = useHud(store, (s) => s.teamScores);
  const rows = useHud(store, (s) => s.scoreboard);
  const timeLeft = useHud(store, (s) => s.timeLeft);
  if (phase !== 'ended') {
    return null;
  }
  const title = winner === 'draw' ? '平手' : winner === team ? '勝利' : '落敗';
  const best = [...rows].sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    <div className="overlay result" data-testid="match-result">
      <div className="panel">
        <h1 className="title">{title}</h1>
        <p className="subtitle">
          ALPHA {Math.ceil(scores.alpha)} : {Math.ceil(scores.bravo)} BRAVO
        </p>
        <ol className="result__best">
          {best.map((r) => (
            <li key={r.id}>
              {r.name} — {r.score} 分（{r.kills}/{r.deaths}/{r.assists}）
            </li>
          ))}
        </ol>
        <p className="muted">下一場將在 {Math.ceil(timeLeft)} 秒後開始</p>
        {onLeave && (
          <button type="button" className="button" onClick={onLeave}>
            離開對戰
          </button>
        )}
      </div>
    </div>
  );
}

/** 遊戲內 HUD。準星由遊戲迴圈直接更新（CSS 變數），不經過 React。 */
export function Hud({ store, crosshairRef, onLeave }: { store: HudStore; crosshairRef: (el: HTMLDivElement | null) => void; onLeave?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  // 擊殺訊息逾時移除
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="hud">
      <div ref={crosshairRef} className="crosshair-dynamic" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <HitMarker store={store} />
      <DamageIndicator store={store} />
      <MatchBar store={store} />
      <CaptureProgress store={store} />
      <KillFeed store={store} now={now} />
      <HealthPanel store={store} />
      <WeaponPanel store={store} />
      <StatusOverlay store={store} />
      <Scoreboard store={store} />
      <MatchResult store={store} {...(onLeave ? { onLeave } : {})} />
    </div>
  );
}
