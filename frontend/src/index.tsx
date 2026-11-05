import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
