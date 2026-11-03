import type { CompatibilityReport } from '../game/core/compatibility';

export function CompatibilityNotice({ report }: { report: CompatibilityReport }) {
  return (
    <div className="overlay overlay--solid" role="alert">
      <div className="panel">
        <h1 className="title">無法啟動 FRONTLINE</h1>
        <p>你的瀏覽器缺少執行遊戲所需的功能：</p>
        <ul className="problems">
          {report.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="muted">建議使用最新版桌面 Chrome 或 Edge，並確認已開啟硬體加速。</p>
      </div>
    </div>
  );
}
