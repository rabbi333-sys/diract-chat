import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { syncActiveConnectionToServer } from "./lib/db-config";

// Push stored DB credentials to the API server on startup so n8n can call
// /api/ai-status with just session_id without any manual re-save needed.
syncActiveConnectionToServer();

createRoot(document.getElementById("root")!).render(<App />);
