import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppStateProvider } from "./state/AppState";
import { applyTheme } from "./hooks/useTheme";
import "./styles/globals.css";

// Apply the theme before first paint to avoid a flash. Default = light-green.
applyTheme(
  (() => {
    const stored = localStorage.getItem("chordmatik:theme:v2");
    return stored === "dark" ? "dark" : "light";
  })(),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppStateProvider>
      <App />
    </AppStateProvider>
  </React.StrictMode>,
);
