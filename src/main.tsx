import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SkillsMarketplace from "./components/SkillsMarketplace";
import "./index.css";
import "./App.css";
import { initializeTheme } from "./themes";

initializeTheme();

const params = new URLSearchParams(window.location.search);
const view = params.get("view");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "marketplace" ? <SkillsMarketplace /> : <App />}
  </React.StrictMode>,
);
