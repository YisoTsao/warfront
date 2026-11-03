import { formatCode, type InputAction, type KeyBindings } from '../game/input/keyBindings';

const SHOWN: ReadonlyArray<[InputAction | 'move' | 'look', string]> = [
  ['move', '移動'],
  ['look', '視角'],
  ['sprint', '衝刺（只能往前）'],
  ['jump', '跳躍／起身'],
  ['crouch', '蹲下'],
  ['prone', '臥倒'],
  ['fire', '開火'],
  ['aim', '瞄準'],
  ['reload', '換彈'],
  ['fireMode', '射擊模式'],
  ['grenade', '手榴彈'],
  ['ability', '兵種技能'],
  ['scoreboard', '計分板'],
];

export function Controls({ bindings }: { bindings: KeyBindings }) {
  return (
    <dl className="controls">
      {SHOWN.map(([action, label]) => (
        <div key={action} className="controls__row">
          <dt>{action === 'move' ? 'W A S D' : action === 'look' ? '滑鼠' : bindings[action].map(formatCode).join(' / ')}</dt>
          <dd>{label}</dd>
        </div>
      ))}
      <div className="controls__row">
        <dt>Esc</dt>
        <dd>暫停並釋放滑鼠</dd>
      </div>
    </dl>
  );
}
