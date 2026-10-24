import type { KdsState, KdsActions } from "../../data/contract";
import TopBar from "./TopBar";
import Board from "./Board";
import AllDay from "./AllDay";
import { StockPanel } from "../../components/StockPanel";
import "./CardsView.css";

const ALERT_MIN = 10;

/** 案0「カード型」: 上に時計と件数、左に注文カードの折り返しグリッド、右に当日の予約 */
export default function CardsView({ state, actions }: { state: KdsState; actions: KdsActions }) {
  const active = state.cards.filter((c) => !c.finishing);
  const alertCount = active.filter((c) => state.now - c.order.start >= ALERT_MIN * 60000).length;
  return (
    <div className="kds-app">
      <TopBar now={state.now} activeCount={active.length} alertCount={alertCount} connection={state.connection} />
      <AllDay cards={state.cards} />
      <div className="kds-app-body">
        <Board cards={state.cards} now={state.now} actions={actions} />
        <StockPanel stock={state.stock} now={state.now} onSeat={actions.seatReservation} />
      </div>
    </div>
  );
}
