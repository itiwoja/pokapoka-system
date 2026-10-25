import type { Connection } from "../../types";
import { hhmm } from "../../time";
import "./TopBar.css";

interface Props {
  now: number;
  activeCount: number;
  alertCount: number;
  connection: Connection;
}

export default function TopBar({ now, activeCount, alertCount, connection }: Props) {
  return (
    <header className="kds-topbar-wrap">
      <div className="kds-topbar">
        <span className="kds-topbar-clock">{hhmm(now)}</span>
        <div className="kds-topbar-counts">
          <span className="kds-topbar-count">進行中 <b>{activeCount}</b></span>
          {alertCount > 0 && (
            <span className="kds-topbar-count kds-topbar-count--alert">10分超 <b>{alertCount}</b></span>
          )}
        </div>
      </div>
      {connection === "offline" && (
        <div className="kds-topbar-offline" role="alert">
          サーバーにつながっていません。表示が古い可能性があります
        </div>
      )}
    </header>
  );
}
