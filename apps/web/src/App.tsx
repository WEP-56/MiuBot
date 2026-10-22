import { useState } from "react";
import { Sidebar, type PageId } from "./components/Sidebar";
import { ThemeProvider } from "./theme";
import { Dashboard } from "./pages/Dashboard";
import { Platforms } from "./pages/Platforms";
import { Providers } from "./pages/Providers";
import { Personas } from "./pages/Personas";
import { Sessions } from "./pages/Sessions";
import { Debug } from "./pages/Debug";
import { Stickers } from "./pages/Stickers";
import { Plugins } from "./pages/Plugins";
import {
  Proactive,
  MCP,
  Skills,
  Memory,
  Scheduler,
  Logs,
  Settings,
  Tools,
} from "./pages/Advanced";

export default function App() {
  const [page, setPage] = useState<PageId>("platforms");

  const renderContent = () => {
    switch (page) {
      case "dashboard":
        return <Dashboard onNav={(p) => setPage(p as PageId)} />;
      case "platforms":
        return <Platforms />;
      case "providers":
        return <Providers />;
      case "personas":
        return <Personas />;
      case "sessions":
        return <Sessions />;
      case "debug":
        return <Debug />;
      case "stickers":
        return <Stickers />;
      case "proactive":
        return <Proactive />;
      case "mcp":
        return <MCP />;
      case "skills":
        return <Skills />;
      case "memory":
        return <Memory />;
      case "scheduler":
        return <Scheduler />;
      case "tools":
        return <Tools />;
      case "extensions":
        return <Plugins />;
      case "logs":
        return <Logs />;
      case "settings":
        return <Settings />;
      default:
        return <Dashboard onNav={(p) => setPage(p as PageId)} />;
    }
  };

  return (
    <ThemeProvider>
      <div
        className="flex h-screen w-screen overflow-hidden font-sans antialiased"
        style={{ background: "var(--bg-app)", color: "var(--text-main)" }}
      >
        {/* Left Sidebar */}
        <Sidebar current={page} onChange={setPage} />

        {/* Main Content Pane */}
        <main
          className="flex-1 h-full overflow-hidden flex flex-col"
          style={{ background: "var(--bg-app)" }}
        >
          {renderContent()}
        </main>
      </div>
    </ThemeProvider>
  );
}
