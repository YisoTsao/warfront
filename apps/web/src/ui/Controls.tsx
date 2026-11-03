const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['W A S D', '移動'],
  ['滑鼠', '視角'],
  ['Shift（按住）', '衝刺（只能往前）'],
  ['空白鍵', '跳躍'],
  ['C', '蹲下／站起'],
  ['Esc', '暫停並釋放滑鼠'],
];

export function Controls() {
  return (
    <dl className="controls">
      {CONTROLS.map(([key, action]) => (
        <div key={key} className="controls__row">
          <dt>{key}</dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  );
}
