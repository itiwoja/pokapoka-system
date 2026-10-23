import { useKds } from "./data/useKds";
import CardsView from "./views/cards/CardsView";

export default function App() {
  const { state, actions } = useKds();
  return <CardsView state={state} actions={actions} />;
}
