import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Dev-only handle for automated UI tests.
if (import.meta.env.DEV) {
  void Promise.all([import("./state/documentStore"), import("./state/uiStore"), import("./state/searchStore")]).then(
    ([d, u, s]) => Object.assign(window, { __marmara: { doc: d.useDoc, ui: u.useUi, search: s.useSearch } }),
  );
}
