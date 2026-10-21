// The shared foundation first, then the per-area styles, and only then the
// app: stylesheets a component imports land in the bundle in import order,
// so importing App first would put them ahead of index.css and let the
// foundation override them.
import "./index.css";
import "./styles/transactions.css";
import "./styles/analytics.css";
import "./styles/settings.css";
import "./styles/people.css";
import "./styles/trips.css";
import "./styles/ask.css";
import "./styles/signin.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { applyTheme, storedTheme } from "./lib/theme";

// Applied before render so a dark-mode user never sees a light flash.
applyTheme(storedTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
